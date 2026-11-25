// Sign: envelopes from draft to completed. Adapted from GR OS Sign (OS_Beta f674d5b) without the company seal, the
// internal Google-signer path or HR contracts. Every state change writes a SignEvent; every PDF state is a new
// write-once SignDocVersion with its SHA-256. Pages, actions, MCP tools and the daily job all go through here.
import type { SignEnvelope, SignSigner, User } from "@prisma/client";
import { db } from "../db";
import { now as clockNow, plusDays } from "../clock";
import { deleteBytes, readBytes, saveBytes } from "../file/storage";
import { decrypt, encrypt } from "../file/crypto";
import { appUrl } from "../email";
import { appSettings, currentConsent } from "../settings";
import { dateShort, dateTime, timeOnly, withUtc } from "../tz";
import { canCreateEnvelopes, canManage, envelopeRole, viewersOf, type Viewer } from "./config";
import { CODE_ATTEMPTS, CODE_MINUTES, CODES_PER_10_MIN, CODES_PER_DAY, LOCK_MINUTES, codeHash, deviceLabel, newCode } from "./identity";
import { downloadToken, newNonce, sessionValue } from "./tokens";
import * as P from "./pdf";
import * as N from "./notify";

export class SignError extends Error {}
const fail = (m: string): never => {
  throw new SignError(m);
};

export type Ctx = { ip: string; ua: string };
const NO_CTX: Ctx = { ip: "", ua: "" };

export const ACTIVE = ["SENT", "PARTIALLY_SIGNED"];
export const STOPPED = ["DECLINED", "VOIDED", "EXPIRED"];
export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Out for signature",
  PARTIALLY_SIGNED: "Partly signed",
  COMPLETED: "Completed",
  DECLINED: "Declined",
  VOIDED: "Voided",
  EXPIRED: "Expired",
};

const now = () => clockNow();
const tz = async () => (await appSettings()).timeZone;

/** Where the owner manages it: the agreement page for agreements, else the envelope page. */
export const ownerLink = (env: Pick<SignEnvelope, "id" | "source" | "sourceRef">) => (env.source === "AGREEMENT" && env.sourceRef ? `/agreements/${env.sourceRef}` : `/envelopes/${env.id}`);

// ---------- events and versions ----------

export async function logEvent(envelopeId: string, type: string, o: { signerId?: string | null; actorId?: string | null; ctx?: Ctx; details?: string } = {}) {
  await db.signEvent.create({
    data: { envelopeId, type, signerId: o.signerId ?? null, actorId: o.actorId ?? null, at: await now(), ip: o.ctx?.ip ?? "", userAgent: (o.ctx?.ua ?? "").slice(0, 300), details: (o.details ?? "").slice(0, 500) },
  });
}

export const latestVersion = (envelopeId: string) => db.signDocVersion.findFirst({ where: { envelopeId }, orderBy: { seq: "desc" } });

class Retry extends Error {}

/** Write-once: a new row and a new encrypted file every time; nothing is ever overwritten. */
async function addVersion(envelopeId: string, kind: string, bytes: Uint8Array, signerId: string | null = null, expectSeq?: number) {
  const prev = await latestVersion(envelopeId);
  const seq = (prev?.seq ?? 0) + 1;
  if (expectSeq !== undefined && seq !== expectSeq) throw new Retry();
  const buf = Buffer.from(bytes);
  const storageKey = await saveBytes(buf);
  return db.signDocVersion.create({ data: { envelopeId, seq, kind, signerId, storageKey, sha256: P.sha256(buf), sizeBytes: buf.length, createdAt: await now() } });
}

export const versionBytes = (v: { storageKey: string }) => readBytes(v.storageKey);

/** One envelope's PDF changes at a time in this process (parallel signers finishing together). */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

// ---------- creating ----------

export type NewEnvelope = { title: string; bytes: Buffer; fileName: string; source?: "UPLOAD" | "AGREEMENT"; sourceRef?: string };

export async function createEnvelope(actor: User, input: NewEnvelope, ctx: Ctx = NO_CTX) {
  if (!canCreateEnvelopes(actor)) fail("Your account can't send documents.");
  const source = input.source ?? "UPLOAD";
  const title = input.title.trim();
  if (!title) fail("Give the document a title.");
  let doc: Awaited<ReturnType<typeof P.asPdf>>;
  let pages: number;
  try {
    doc = await P.asPdf(input.bytes, input.fileName || "document.pdf");
    pages = await P.checkPdf(doc.bytes);
  } catch (e) {
    throw new SignError((e as Error).message);
  }
  const t = await now();
  const env = await db.signEnvelope.create({
    data: {
      title: title.slice(0, 200),
      source,
      sourceRef: (input.sourceRef ?? "").slice(0, 200),
      ownerId: actor.id,
      fileName: (doc.name || "document.pdf").replace(/[^\w .()-]/g, "_").slice(0, 120),
      pageCount: pages,
      originalHash: P.sha256(doc.bytes),
      createdAt: t,
    },
  });
  await addVersion(env.id, "ORIGINAL", doc.bytes);
  const anchors = await P.findAnchors(doc.bytes).catch(() => []);
  if (anchors.length) await addVersion(env.id, "PREPARED", await P.hideAnchors(doc.bytes, anchors));
  await logEvent(env.id, "CREATED", { actorId: actor.id, ctx, details: `${source}, ${pages} page${pages === 1 ? "" : "s"}${doc.fromImage ? ", made from an image" : ""}${anchors.length ? `, ${anchors.length} anchor${anchors.length === 1 ? "" : "s"}` : ""}` });
  return env;
}

async function draft(actor: User, id: string) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env || !canManage(actor, env)) fail("Document not found.");
  if (env!.status !== "DRAFT") fail("This document has been sent; it can't be changed.");
  return env!;
}

export type SignerInput = { id?: string; name: string; email: string; company?: string; role?: string };
export const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The signers, in order. A signer whose email is an active user is linked (their saved signature is offered). */
export async function setSigners(actor: User, id: string, list: SignerInput[], signingOrder: "SEQUENTIAL" | "PARALLEL") {
  const env = await draft(actor, id);
  if (!list.length) fail("Add at least one signer.");
  if (list.length > 10) fail("Up to 10 signers per document.");
  const resolved = [];
  for (const [i, s] of list.entries()) {
    const email = s.email.trim().toLowerCase();
    if (!s.name.trim()) fail(`Signer ${i + 1} needs a name.`);
    if (!EMAIL.test(email)) fail(`Signer ${i + 1}'s email address doesn't look right.`);
    const user = await db.user.findFirst({ where: { email, active: true } });
    resolved.push({ id: s.id, name: s.name.trim().slice(0, 120), email, company: (s.company ?? "").trim().slice(0, 120), role: (s.role ?? "").trim().slice(0, 60), userId: user?.id ?? null, order: i + 1 });
  }
  if (new Set(resolved.map((r) => r.email)).size !== resolved.length) fail("Each signer needs their own email address.");
  const existing = await db.signSigner.findMany({ where: { envelopeId: id } });
  const keep = new Set(resolved.map((r) => r.id).filter(Boolean));
  const gone = existing.filter((s) => !keep.has(s.id)).map((s) => s.id);
  await db.signField.deleteMany({ where: { signerId: { in: gone } } });
  await db.signSigner.deleteMany({ where: { id: { in: gone } } });
  for (const r of resolved) {
    const data = { order: r.order, name: r.name, email: r.email, company: r.company, role: r.role, userId: r.userId };
    if (r.id && existing.some((e) => e.id === r.id)) await db.signSigner.update({ where: { id: r.id }, data });
    else await db.signSigner.create({ data: { ...data, envelopeId: id } });
  }
  await db.signEnvelope.update({ where: { id }, data: { signingOrder } });
  // Anchors in the PDF place fields as soon as their signers exist (unless fields were already placed).
  if (!(await db.signField.count({ where: { envelopeId: id } }))) await applyAnchors(actor, env.id);
  return db.signSigner.findMany({ where: { envelopeId: id }, orderBy: { order: "asc" } });
}

export type FieldInput = { signerId: string; type: P.FieldType; page: number; x: number; y: number; width: number; height: number; required?: boolean; label?: string; placedBy?: string };

function checkGeometry(f: { page: number; x: number; y: number; width: number; height: number }, pages: number) {
  const ok = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  if (!Number.isInteger(f.page) || f.page < 1 || f.page > pages) fail("A field is on a page that doesn't exist.");
  if (![f.x, f.y, f.width, f.height].every(ok) || f.width <= 0 || f.height <= 0 || f.x + f.width > 1.0001 || f.y + f.height > 1.0001) fail("A field is outside the page.");
}

/** Replace every field on a draft. */
export async function setFields(actor: User, id: string, fields: FieldInput[]) {
  const env = await draft(actor, id);
  const signers = new Set((await db.signSigner.findMany({ where: { envelopeId: id } })).map((s) => s.id));
  if (fields.length > 500) fail("Too many fields.");
  for (const f of fields) {
    if (!signers.has(f.signerId)) fail("A field belongs to a signer who isn't on this document.");
    if (!P.FIELD_TYPES.includes(f.type)) fail("Unknown field type.");
    checkGeometry(f, env.pageCount);
  }
  await db.signField.deleteMany({ where: { envelopeId: id } });
  await db.signField.createMany({
    data: fields.map((f) => ({
      envelopeId: id,
      signerId: f.signerId,
      type: f.type,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      required: f.type === "SIGNATURE" || f.type === "INITIALS" || f.type === "DATE_SIGNED" || f.type === "NAME" ? true : f.required !== false,
      label: (f.label ?? "").slice(0, 60),
      placedBy: f.placedBy ?? "DRAG",
    })),
  });
}

/** Fields from the PDF's {{sig:N}}-style tokens, for the signers that exist. Returns how many were placed. */
export async function applyAnchors(actor: User, id: string) {
  await draft(actor, id);
  const orig = await db.signDocVersion.findFirst({ where: { envelopeId: id, kind: "ORIGINAL" }, orderBy: { seq: "desc" } });
  const anchors = orig ? await P.findAnchors(await versionBytes(orig)) : [];
  const signers = await db.signSigner.findMany({ where: { envelopeId: id } });
  const byOrder = new Map(signers.map((s) => [s.order, s.id]));
  const fields = anchors.filter((a) => byOrder.has(a.signer)).map((a) => ({ ...a, signerId: byOrder.get(a.signer)!, placedBy: "ANCHOR" }));
  if (fields.length) await setFields(actor, id, fields);
  return fields.length;
}

export async function anchorSummary(id: string) {
  const orig = await db.signDocVersion.findFirst({ where: { envelopeId: id, kind: "ORIGINAL" }, orderBy: { seq: "desc" } });
  const anchors = orig ? await P.findAnchors(await versionBytes(orig)).catch(() => []) : [];
  return { count: anchors.length, signers: [...new Set(anchors.map((a) => a.signer))].sort((a, b) => a - b) };
}

export type Options = { title?: string; message?: string; expiresAt?: Date | null; viewers?: Viewer[]; confidential?: boolean; signingOrder?: "SEQUENTIAL" | "PARALLEL" };

export async function setOptions(actor: User, id: string, o: Options) {
  await draft(actor, id);
  const t = await now();
  if (o.expiresAt && o.expiresAt.getTime() <= t.getTime()) fail("The sign-by date must be in the future.");
  let viewers: Viewer[] | undefined;
  if (o.viewers) {
    viewers = [];
    for (const v of o.viewers) {
      const email = (v.email ?? "").trim().toLowerCase();
      if (!email) continue;
      if (!EMAIL.test(email)) fail(`The cc address ${email} doesn't look right.`);
      if (!viewers.some((x) => x.email === email)) viewers.push({ name: (v.name ?? "").trim().slice(0, 120), email });
    }
    if (viewers.length > 10) fail("Up to 10 people can be copied.");
  }
  await db.signEnvelope.update({
    where: { id },
    data: {
      ...(o.title !== undefined ? { title: o.title.trim().slice(0, 200) || fail("Give the document a title.") } : {}),
      ...(o.message !== undefined ? { message: o.message.trim().slice(0, 2000) } : {}),
      ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
      ...(viewers ? { viewers: JSON.stringify(viewers) } : {}),
      ...(o.confidential !== undefined ? { confidential: o.confidential } : {}),
      ...(o.signingOrder ? { signingOrder: o.signingOrder } : {}),
    },
  });
}

// ---------- field layouts (saved placements for ready PDFs, SND-6) ----------

export type LayoutField = { signer: number; type: P.FieldType; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string };

export async function saveTemplate(actor: User, id: string, name: string) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env || !canManage(actor, env)) fail("Document not found.");
  if (!name.trim()) fail("Name the layout.");
  const signers = await db.signSigner.findMany({ where: { envelopeId: id } });
  const order = new Map(signers.map((s) => [s.id, s.order]));
  const fields = await db.signField.findMany({ where: { envelopeId: id } });
  if (!fields.length) fail("Place some fields first.");
  const out: LayoutField[] = fields.map((f) => ({ signer: order.get(f.signerId)!, type: f.type as P.FieldType, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label }));
  return db.signFieldTemplate.create({
    data: { name: name.trim().slice(0, 120), pageCount: env!.pageCount, signerCount: Math.max(...out.map((f) => f.signer)), fields: JSON.stringify(out), createdById: actor.id, createdAt: await now() },
  });
}

export const templatesFor = (pageCount?: number) => db.signFieldTemplate.findMany({ where: pageCount ? { pageCount } : {}, orderBy: { name: "asc" } });

export async function applyTemplate(actor: User, id: string, templateId: string) {
  const env = await draft(actor, id);
  const tpl = await db.signFieldTemplate.findUnique({ where: { id: templateId } });
  if (!tpl) fail("Layout not found.");
  if (tpl!.pageCount !== env.pageCount) fail(`That layout is for ${tpl!.pageCount}-page documents; this one has ${env.pageCount}.`);
  const signers = await db.signSigner.findMany({ where: { envelopeId: id } });
  if (signers.length < tpl!.signerCount) fail(`That layout needs ${tpl!.signerCount} signers. Add them first.`);
  const byOrder = new Map(signers.map((s) => [s.order, s.id]));
  const fields = (JSON.parse(tpl!.fields) as LayoutField[]).map((f) => ({ ...f, signerId: byOrder.get(f.signer)!, placedBy: "TEMPLATE" }));
  await setFields(actor, id, fields);
  return fields.length;
}

export async function deleteTemplate(actor: User, templateId: string) {
  const tpl = await db.signFieldTemplate.findUnique({ where: { id: templateId } });
  if (!tpl) return;
  if (tpl.createdById !== actor.id && actor.role !== "ADMIN") fail("Only whoever saved the layout (or an Admin) can delete it.");
  await db.signFieldTemplate.delete({ where: { id: templateId } });
}

// ---------- sending ----------

/** The envelope's owner; if they've been removed, the first Admin takes their notices. */
async function owner(env: Pick<SignEnvelope, "ownerId">) {
  return (await db.user.findUnique({ where: { id: env.ownerId } })) ?? (await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } }));
}

/** Who should be signing now: everyone not yet done (parallel), or the lowest order still to sign (sequential). */
export function currentTurn<S extends Pick<SignSigner, "id" | "order" | "status">>(env: Pick<SignEnvelope, "signingOrder">, signers: S[]): S[] {
  const open = signers.filter((s) => s.status !== "SIGNED" && s.status !== "DECLINED");
  if (env.signingOrder === "PARALLEL" || !open.length) return open;
  const next = Math.min(...open.map((s) => s.order));
  return open.filter((s) => s.order === next);
}

async function invite(env: SignEnvelope, s: SignSigner, kind: N.InviteKind, actorId: string | null, ctx: Ctx = NO_CTX) {
  const nonce = newNonce();
  const signer = await db.signSigner.update({ where: { id: s.id }, data: { linkNonce: nonce, status: s.status === "WAITING" ? "SENT" : s.status } });
  await N.invitation(env, signer, await owner(env), kind);
  await logEvent(env.id, kind === "REMIND" ? "REMINDED" : "SENT", { signerId: s.id, actorId, ctx, details: `${kind === "AMEND" ? "the revised document " : ""}to ${s.email}` });
}

export async function sendEnvelope(actor: User, id: string, ctx: Ctx = NO_CTX) {
  const env = await draft(actor, id);
  const signers = await db.signSigner.findMany({ where: { envelopeId: id }, orderBy: { order: "asc" } });
  if (!signers.length) fail("Add at least one signer.");
  const fields = await db.signField.findMany({ where: { envelopeId: id } });
  for (const s of signers) if (!fields.some((f) => f.signerId === s.id && f.type === "SIGNATURE")) fail(`${s.name} needs at least one signature field.`);
  const t = await now();
  const settings = await appSettings();
  const expiresAt = env.expiresAt ?? plusDays(t, settings.expiryDays);
  if (expiresAt.getTime() <= t.getTime()) fail("The sign-by date must be in the future.");
  const kind = env.sentAt ? "AMEND" : "INVITE";
  const sent = await db.signEnvelope.update({ where: { id }, data: { status: "SENT", sentAt: t, expiresAt } });
  for (const s of currentTurn(sent, signers)) await invite(sent, s, kind, actor.id, ctx);
  await onStatus(sent);
  return sent;
}

// ---------- the signer's side ----------

export type SignerState = { signer: SignSigner; env: SignEnvelope };

export async function loadSigner(signerId: string): Promise<SignerState> {
  const signer = await db.signSigner.findUnique({ where: { id: signerId } });
  const env = signer ? await db.signEnvelope.findUnique({ where: { id: signer.envelopeId } }) : null;
  if (!signer || !env) fail("This signing link isn't valid.");
  await expireIfDue(env!);
  return { signer: signer!, env: (await db.signEnvelope.findUnique({ where: { id: env!.id } }))! };
}

export async function blocked({ signer, env }: SignerState): Promise<string | null> {
  if (signer.status === "SIGNED") return "You've signed this document. Thank you.";
  if (signer.status === "DECLINED") return "You declined to sign this document.";
  if (env.status === "COMPLETED") return "This document has been signed by everyone.";
  if (env.status === "DECLINED") return "This document was declined by a signer, so signing has stopped.";
  if (env.status === "VOIDED") return "The sender cancelled this document.";
  if (env.status === "EXPIRED") return "This signing request has expired. Ask the sender for a new one.";
  if (!ACTIVE.includes(env.status)) return "This document isn't out for signature.";
  const signers = await db.signSigner.findMany({ where: { envelopeId: env.id } });
  if (!currentTurn(env, signers).some((s) => s.id === signer.id)) return "It isn't your turn to sign yet. You'll get an email when it is.";
  return null;
}

async function recentEvents(signerId: string, type: string, minutes: number) {
  const t = await now();
  return db.signEvent.count({ where: { signerId, type, at: { gt: new Date(t.getTime() - minutes * 60_000) } } });
}

/** Email a fresh 6-digit code (signing, or downloading the final copy). */
export async function requestCode(signerId: string, ctx: Ctx = NO_CTX, purpose: "SIGN" | "DOWNLOAD" = "SIGN") {
  const st = await loadSigner(signerId);
  if (purpose === "SIGN") {
    const why = await blocked(st);
    if (why) fail(why);
  } else if (st.env.status !== "COMPLETED") fail("The document isn't completed yet.");
  if ((await recentEvents(signerId, "CODE_SENT", 10)) >= CODES_PER_10_MIN) fail("Too many codes requested. Wait 10 minutes and try again.");
  if ((await recentEvents(signerId, "CODE_SENT", 24 * 60)) >= CODES_PER_DAY) fail("Too many codes requested today. Try again tomorrow or ask the sender.");
  const code = newCode();
  const t = await now();
  await db.signSigner.update({ where: { id: signerId }, data: { codeHash: codeHash(signerId, code), codeExpiresAt: new Date(t.getTime() + CODE_MINUTES * 60_000), codeAttempts: 0 } });
  await N.code(st.env, st.signer, code);
  await logEvent(st.env.id, "CODE_SENT", { signerId, ctx, details: purpose === "DOWNLOAD" ? "for download" : "" });
  return code; // returned for tests only; callers never show it
}

/** Check a code. Wrong 5 times: locked for 15 minutes. Right: the link is used up and a 2-hour session starts. */
export async function verifyCode(signerId: string, code: string, ctx: Ctx = NO_CTX, purpose: "SIGN" | "DOWNLOAD" = "SIGN") {
  const { signer, env } = await loadSigner(signerId);
  const t = await now();
  if (signer.codeLockedUntil && signer.codeLockedUntil > t) fail(`Too many wrong codes. Try again after ${timeOnly(signer.codeLockedUntil, await tz())}.`);
  if (!signer.codeHash || !signer.codeExpiresAt) fail("Ask for a code first.");
  if (signer.codeExpiresAt! <= t) fail("That code has expired. Ask for a new one.");
  if (codeHash(signerId, (code ?? "").replace(/\D/g, "")) !== signer.codeHash) {
    const attempts = signer.codeAttempts + 1;
    if (attempts >= CODE_ATTEMPTS) {
      await db.signSigner.update({ where: { id: signerId }, data: { codeAttempts: 0, codeHash: "", codeLockedUntil: new Date(t.getTime() + LOCK_MINUTES * 60_000) } });
      await logEvent(env.id, "CODE_LOCKED", { signerId, ctx });
      fail(`Too many wrong codes. Locked for ${LOCK_MINUTES} minutes.`);
    }
    await db.signSigner.update({ where: { id: signerId }, data: { codeAttempts: attempts } });
    await logEvent(env.id, "CODE_FAILED", { signerId, ctx });
    fail(`That code isn't right. ${CODE_ATTEMPTS - attempts} ${CODE_ATTEMPTS - attempts === 1 ? "try" : "tries"} left.`);
  }
  const sessionNonce = newNonce();
  await db.signSigner.update({
    where: { id: signerId },
    data: { codeHash: "", codeAttempts: 0, codeLockedUntil: null, sessionNonce, ...(purpose === "SIGN" ? { linkNonce: newNonce(), verifiedAt: t } : {}) },
  });
  await logEvent(env.id, "CODE_VERIFIED", { signerId, ctx, details: purpose === "DOWNLOAD" ? "for download" : "" });
  return sessionValue(signerId, sessionNonce, t);
}

export async function markViewed(signerId: string, ctx: Ctx = NO_CTX) {
  const s = await db.signSigner.findUnique({ where: { id: signerId } });
  if (!s || s.viewedAt) return;
  await db.signSigner.update({ where: { id: signerId }, data: { viewedAt: await now(), status: s.status === "SENT" ? "VIEWED" : s.status } });
  await logEvent(s.envelopeId, "VIEWED", { signerId, ctx });
  const env = await db.signEnvelope.findUnique({ where: { id: s.envelopeId } });
  if (env) await onStatus(env, "VIEWED");
}

export type SignatureMethod = "TYPED" | "DRAWN" | "UPLOADED";
const METHODS: SignatureMethod[] = ["TYPED", "DRAWN", "UPLOADED"];

export type SigningInput = {
  values: Record<string, string>; // fieldId -> value for TEXT, TITLE, CHECKBOX ("true"/"false")
  signature: string; // PNG data URL
  initials?: string;
  typedName: string;
  consent: boolean;
  reachedEnd: boolean;
  /** Users only: keep this signature (and initials) for their next documents. */
  remember?: boolean;
  method?: SignatureMethod;
};

const MAX_IMAGE = 400_000;
const isPng = (s: string | undefined) => !!s && s.length < MAX_IMAGE && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s);

// ---------- saved signatures (users) ----------

export type SavedSignature = { signature: string; initials: string; method: SignatureMethod; updatedAt: Date };

export async function savedSignature(userId: string): Promise<SavedSignature | null> {
  const p = await db.signaturePreference.findUnique({ where: { userId } });
  return p
    ? { signature: decrypt(p.signatureImage), initials: p.initialsImage ? decrypt(p.initialsImage) : "", method: (METHODS as string[]).includes(p.method) ? (p.method as SignatureMethod) : "TYPED", updatedAt: p.updatedAt }
    : null;
}

async function storeSignature(userId: string, signature: string, initials: string | undefined, method: SignatureMethod | undefined, t: Date) {
  await db.signaturePreference.upsert({
    where: { userId },
    create: { userId, signatureImage: encrypt(signature), initialsImage: initials ? encrypt(initials) : "", method: method ?? "TYPED", updatedAt: t },
    update: { signatureImage: encrypt(signature), ...(initials ? { initialsImage: encrypt(initials) } : {}), ...(method ? { method } : {}), updatedAt: t },
  });
}

export async function saveMySignature(user: Pick<User, "id">, input: { signature: string; initials?: string; method?: string }) {
  if (!isPng(input.signature)) fail("Create a signature first (type, draw or upload it).");
  if (input.initials && !isPng(input.initials)) fail("Your initials couldn't be read. Try again.");
  const method = METHODS.find((m) => m === input.method) ?? "TYPED";
  await storeSignature(user.id, input.signature, input.initials || undefined, method, await now());
}

export async function forgetSavedSignature(userId: string) {
  await db.signaturePreference.deleteMany({ where: { userId } });
}

export async function completeSigning(signerId: string, input: SigningInput, ctx: Ctx = NO_CTX) {
  const st = await loadSigner(signerId);
  const { signer, env } = st;
  const why = await blocked(st);
  if (why) fail(why);
  if (!signer.verifiedAt) fail("Confirm who you are first.");
  if ((await recentEvents(signerId, "SIGN_FAILED", 60)) >= 10) fail("Too many attempts. Wait an hour, or ask the sender for help.");
  const problem = async (m: string): Promise<never> => {
    await logEvent(env.id, "SIGN_FAILED", { signerId, ctx, details: m.slice(0, 80) });
    return fail(m);
  };
  const settings = await appSettings();
  const consent = currentConsent(settings);
  if (!input.consent) await problem("Tick the box to agree to use electronic records and signatures.");
  if (!input.reachedEnd) await problem("Scroll to the last page before you finish.");
  const typedName = (input.typedName ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (typedName.length < 2) await problem("Type your full legal name.");
  if (!isPng(input.signature)) await problem("Adopt a signature first.");
  const fields = await db.signField.findMany({ where: { envelopeId: env.id, signerId } });
  if (fields.some((f) => f.type === "INITIALS") && !isPng(input.initials)) await problem("Adopt your initials first.");
  const values = new Map<string, string>();
  for (const f of fields) {
    const raw = (input.values?.[f.id] ?? "").toString();
    const v = f.type === "CHECKBOX" ? (raw === "true" ? "true" : "false") : f.type === "TEXT" || f.type === "TITLE" ? raw.trim().slice(0, 200) : "";
    if (f.required && ((f.type === "CHECKBOX" && v !== "true") || ((f.type === "TEXT" || f.type === "TITLE") && !v))) await problem(`Complete every required field (${f.label || P.FIELD_LABEL[f.type as P.FieldType]}, page ${f.page}).`);
    values.set(f.id, v);
  }
  const t = await now();
  const dateText = dateShort(t, settings.timeZone);

  await withLock(env.id, async () => {
    const cur = await db.signEnvelope.findUnique({ where: { id: env.id } });
    const me = await db.signSigner.findUnique({ where: { id: signerId } });
    if (!cur || !ACTIVE.includes(cur.status) || !me?.verifiedAt) fail("The sender has changed this document. Use the new link they send you.");
    for (let attempt = 0; ; attempt++) {
      const base = await latestVersion(env.id);
      const stamped = await P.stamp(await versionBytes(base!), {
        fields: fields.map((f) => ({ page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, type: f.type as P.FieldType, value: values.get(f.id) ?? "" })),
        signature: input.signature,
        initials: input.initials,
        name: typedName,
        dateText,
      });
      try {
        await addVersion(env.id, "SIGNER", stamped, signerId, base!.seq + 1);
        break;
      } catch (e) {
        if (attempt < 3 && (e instanceof Retry || /Unique constraint/i.test((e as Error).message))) continue;
        throw e;
      }
    }
  });
  for (const f of fields) {
    await db.signField.update({ where: { id: f.id }, data: { value: f.type === "DATE_SIGNED" ? dateText : f.type === "NAME" ? typedName : values.get(f.id) ?? "" } });
    await logEvent(env.id, "FIELD_COMPLETED", { signerId, ctx, details: `${P.FIELD_LABEL[f.type as P.FieldType]}, page ${f.page}` });
  }
  await db.signSigner.update({
    where: { id: signerId },
    data: {
      status: "SIGNED",
      signedAt: t,
      ip: ctx.ip.slice(0, 64),
      userAgent: ctx.ua.slice(0, 300),
      typedName,
      signatureImage: input.signature,
      initialsImage: input.initials ?? "",
      consentText: consent.text,
      consentVersion: consent.version,
      sessionNonce: "",
      linkNonce: "",
    },
  });
  // Users signing as themselves may keep the signature for next time (applied later only by a deliberate click).
  const saved = signer.userId ? await savedSignature(signer.userId) : null;
  const reused = !!saved && saved.signature === input.signature;
  if (signer.userId && input.remember && !reused) await storeSignature(signer.userId, input.signature, isPng(input.initials) ? input.initials : undefined, input.method && METHODS.includes(input.method) ? input.method : undefined, t);
  await logEvent(env.id, "SIGNED", { signerId, ctx, details: `as ${typedName}${reused ? ", with their saved signature" : ""}; consent v${consent.version}` });
  await advance(env.id, signerId);
}

async function advance(envelopeId: string, justSignedId: string) {
  const env = await db.signEnvelope.findUniqueOrThrow({ where: { id: envelopeId } });
  const signers = await db.signSigner.findMany({ where: { envelopeId }, orderBy: { order: "asc" } });
  const who = signers.find((s) => s.id === justSignedId)!;
  if (signers.every((s) => s.status === "SIGNED")) return completeEnvelope(envelopeId);
  const updated = await db.signEnvelope.update({ where: { id: envelopeId }, data: { status: "PARTIALLY_SIGNED" } });
  await N.ownerNotice(updated, await owner(env), "SIGNED", who.name, ownerLink(updated));
  for (const s of currentTurn(updated, signers)) if (s.status === "WAITING") await invite(updated, s, "INVITE", null);
  await onStatus(updated);
}

/** Every signer has signed: certificate, hash, optional digital certificate, lock, notify. */
async function completeEnvelope(envelopeId: string) {
  return withLock(`${envelopeId}:complete`, async () => {
    const env = await db.signEnvelope.findUniqueOrThrow({ where: { id: envelopeId } });
    if (env.status === "COMPLETED") return env;
    const signers = await db.signSigner.findMany({ where: { envelopeId }, orderBy: { order: "asc" } });
    const t = await now();
    const settings = await appSettings();
    const zone = settings.timeZone;
    const cfg = P.certConfig();
    const certNote = cfg ? `PDF digital signature by ${settings.companyName} (SHA-256)` : "No digital certificate";
    const base = await latestVersion(envelopeId);
    let bytes: Uint8Array = await P.appendCertificate(await versionBytes(base!), {
      title: env.title,
      envelopeId: env.id,
      sourceRef: env.sourceRef && env.source === "AGREEMENT" ? ((await db.agreement.findUnique({ where: { id: env.sourceRef } }))?.reference ?? "") : "",
      originalHash: env.originalHash,
      completedAt: withUtc(t, zone),
      certNote,
      company: settings.companyName,
      timeNote: `Times are in ${zone} with UTC.`,
      signers: signers.map((s) => ({
        order: s.order,
        name: s.typedName || s.name,
        role: s.role,
        email: s.email,
        company: s.company,
        auth: "6-digit code sent to this email address",
        viewedAt: withUtc(s.viewedAt, zone),
        signedAt: withUtc(s.signedAt, zone),
        ip: s.ip,
        device: deviceLabel(s.userAgent),
        consent: `(v${s.consentVersion}) ${s.consentText}`,
        signature: s.signatureImage,
      })),
    });
    let certified = false;
    if (cfg) {
      try {
        bytes = await P.certify(bytes, cfg, t, settings.companyName);
        certified = true;
      } catch (e) {
        console.error(`[sign] digital certificate failed for ${envelopeId}: ${(e as Error).message}`);
      }
    }
    const v = await addVersion(envelopeId, "FINAL", bytes);
    const done = await db.signEnvelope.update({
      where: { id: envelopeId },
      data: { status: "COMPLETED", completedAt: t, finalHash: v.sha256, certified, certNote: certified ? certNote : cfg ? "Digital certificate failed; not applied" : "No digital certificate" },
    });
    await logEvent(envelopeId, "COMPLETED", { details: `SHA-256 ${v.sha256}${certified ? ", digitally certified" : ""}` });
    await onStatus(done);
    const viewers = viewersOf(done).map((viewer, i) => ({ viewer, token: downloadToken(`${done.id}-v${i}`, t) }));
    await N.completed(done, signers, viewers, await owner(done), Buffer.from(bytes), ownerLink(done));
    return done;
  });
}

export async function declineSigning(signerId: string, reason: string, ctx: Ctx = NO_CTX) {
  const st = await loadSigner(signerId);
  const why = await blocked(st);
  if (why) fail(why);
  if (!st.signer.verifiedAt) fail("Confirm who you are first.");
  const r = (reason ?? "").trim();
  if (r.length < 3) fail("Say why you're declining (the sender will see this).");
  const t = await now();
  await db.signSigner.update({ where: { id: signerId }, data: { status: "DECLINED", declineReason: r.slice(0, 1000), ip: ctx.ip.slice(0, 64), userAgent: ctx.ua.slice(0, 300), sessionNonce: "", linkNonce: "" } });
  const env = await db.signEnvelope.update({ where: { id: st.env.id }, data: { status: "DECLINED", reason: r.slice(0, 1000), stoppedAt: t } });
  await logEvent(env.id, "DECLINED", { signerId, ctx, details: r.slice(0, 300) });
  await stopped(env, "DECLINED", st.signer.name);
}

async function stopped(env: SignEnvelope, kind: "DECLINED" | "VOIDED" | "EXPIRED", by = "") {
  await onStatus(env);
  await N.ownerNotice(env, await owner(env), kind, by, ownerLink(env));
  const signers = await db.signSigner.findMany({ where: { envelopeId: env.id, status: { in: ["SENT", "VIEWED"] } } });
  for (const s of signers) await N.signerStopped(env, s, kind);
}

/** Agreements keep their own status (and Airtable) in step with the envelope. */
async function onStatus(env: SignEnvelope, event?: "VIEWED") {
  if (env.source !== "AGREEMENT" || !env.sourceRef) return;
  const { onEnvelopeStatus } = await import("../agreements/sync");
  await onEnvelopeStatus(env, event).catch((e) => console.error(`[sign] agreement sync failed for ${env.id}: ${(e as Error).message}`));
}

// ---------- the owner's side ----------

export async function voidEnvelope(actor: User, id: string, reason: string, ctx: Ctx = NO_CTX) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env || !canManage(actor, env)) fail("Document not found.");
  if (![...ACTIVE, "DRAFT"].includes(env!.status)) fail("Only a draft or a document out for signature can be voided.");
  if ((reason ?? "").trim().length < 3) fail("Give a reason for voiding (signers will see it).");
  const v = await db.signEnvelope.update({ where: { id }, data: { status: "VOIDED", reason: reason.trim().slice(0, 1000), stoppedAt: await now() } });
  await db.signSigner.updateMany({ where: { envelopeId: id }, data: { linkNonce: "", sessionNonce: "" } });
  await logEvent(id, "VOIDED", { actorId: actor.id, ctx, details: reason.trim().slice(0, 300) });
  if (env!.status !== "DRAFT") await stopped(v, "VOIDED", actor.name);
  else await onStatus(v);
}

export async function extendExpiry(actor: User, id: string, until: Date, ctx: Ctx = NO_CTX) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env || !canManage(actor, env)) fail("Document not found.");
  if (!ACTIVE.includes(env!.status)) fail("Only a document out for signature can be extended.");
  if (until.getTime() <= (await now()).getTime()) fail("Pick a date in the future.");
  await db.signEnvelope.update({ where: { id }, data: { expiresAt: until } });
  await logEvent(id, "EXTENDED", { actorId: actor.id, ctx, details: `to ${dateTime(until, await tz())}` });
}

/** "Remind now": a fresh link to everyone whose turn it is and who hasn't signed. */
export async function remindNow(actor: User | null, id: string, ctx: Ctx = NO_CTX) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env || (actor && !canManage(actor, env))) fail("Document not found.");
  await expireIfDue(env!);
  const fresh = await db.signEnvelope.findUniqueOrThrow({ where: { id } });
  if (!ACTIVE.includes(fresh.status)) fail("This document isn't out for signature.");
  const signers = await db.signSigner.findMany({ where: { envelopeId: id } });
  const due = currentTurn(fresh, signers);
  for (const s of due) await invite(fresh, s, "REMIND", actor?.id ?? null, ctx);
  await db.signEnvelope.update({ where: { id }, data: { lastReminderAt: await now() } });
  return due.length;
}

/** A signer with an expired or used link asks for a new one: it goes to their own address only. */
export async function newLinkForSigner(signerId: string, ctx: Ctx = NO_CTX) {
  const st = await loadSigner(signerId);
  const why = await blocked(st);
  if (why) fail(why);
  if ((await recentEvents(signerId, "LINK_REQUESTED", 60)) >= 3) fail("A new link was sent recently. Check your inbox (and spam folder).");
  await logEvent(st.env.id, "LINK_REQUESTED", { signerId, ctx });
  await invite(st.env, st.signer, "REMIND", null, ctx);
}

/** The owner copies the signing link of whoever's turn it is (no new nonce, so the emailed link keeps working). */
export async function copyLink(actor: User, signerId: string, ctx: Ctx = NO_CTX) {
  const signer = await db.signSigner.findUnique({ where: { id: signerId } });
  const env = signer && (await db.signEnvelope.findUnique({ where: { id: signer.envelopeId } }));
  if (!signer || !env || !canManage(actor, env)) fail("Signer not found.");
  await expireIfDue(env!);
  const fresh = await db.signEnvelope.findUniqueOrThrow({ where: { id: env!.id } });
  if (!ACTIVE.includes(fresh.status)) fail("This document isn't out for signature.");
  const all = await db.signSigner.findMany({ where: { envelopeId: fresh.id } });
  if (!currentTurn(fresh, all).some((s) => s.id === signerId)) fail(`It isn't ${signer!.name}'s turn to sign yet.`);
  const s = signer!.linkNonce ? signer! : await db.signSigner.update({ where: { id: signerId }, data: { linkNonce: newNonce() } });
  await logEvent(fresh.id, "LINK_COPIED", { signerId, actorId: actor.id, ctx, details: `by ${actor.name}` });
  return `${appUrl()}${await N.signingLink(fresh, s)}`;
}

// ---------- revising and deleting, before anyone has signed ----------

const anySigned = async (id: string) => (await db.signSigner.count({ where: { envelopeId: id, status: "SIGNED" } })) > 0;

/** Back to draft while nobody has signed: every link and session stops working and the signers are told. */
export async function reviseEnvelope(actor: User, id: string, ctx: Ctx = NO_CTX) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env || !canManage(actor, env)) fail("Document not found.");
  await expireIfDue(env!);
  const fresh = await db.signEnvelope.findUniqueOrThrow({ where: { id } });
  if (!ACTIVE.includes(fresh.status)) fail("Only a document out for signature can be revised.");
  return withLock(id, async () => {
    if (await anySigned(id)) fail("Someone has already signed, so the document can't change. Void it and send a new one.");
    const told = await db.signSigner.findMany({ where: { envelopeId: id, status: { in: ["SENT", "VIEWED"] } } });
    await db.signSigner.updateMany({ where: { envelopeId: id }, data: { status: "WAITING", viewedAt: null, verifiedAt: null, linkNonce: "", sessionNonce: "", codeHash: "", codeExpiresAt: null } });
    const d = await db.signEnvelope.update({ where: { id }, data: { status: "DRAFT" } });
    await logEvent(id, "REVISING", { actorId: actor.id, ctx, details: "back to draft before anyone signed; earlier links no longer work" });
    for (const s of told) await N.signerRevising(d, s);
    await onStatus(d);
    return d;
  });
}

/** A draft gets a new PDF. Fields stay where they were; any on pages the new PDF doesn't have are taken off. */
export async function replaceDocument(actor: User, id: string, file: { bytes: Buffer; name: string }, ctx: Ctx = NO_CTX) {
  const env = await draft(actor, id);
  let pages: number;
  try {
    const doc = await P.asPdf(file.bytes, file.name || env.fileName);
    file = { bytes: doc.bytes, name: doc.name };
    pages = await P.checkPdf(file.bytes);
  } catch (e) {
    throw new SignError((e as Error).message);
  }
  const hash = P.sha256(file.bytes);
  await addVersion(id, "ORIGINAL", file.bytes);
  const anchors = await P.findAnchors(file.bytes).catch(() => []);
  if (anchors.length) await addVersion(id, "PREPARED", await P.hideAnchors(file.bytes, anchors));
  const dropped = (await db.signField.deleteMany({ where: { envelopeId: id, page: { gt: pages } } })).count;
  await db.signEnvelope.update({ where: { id }, data: { pageCount: pages, originalHash: hash, fileName: (file.name || env.fileName).replace(/[^\w .()-]/g, "_").slice(0, 120) } });
  await logEvent(id, "DOCUMENT_REPLACED", { actorId: actor.id, ctx, details: `${pages} page${pages === 1 ? "" : "s"}, SHA-256 ${hash.slice(0, 16)}...${dropped ? `; ${dropped} field${dropped === 1 ? "" : "s"} on removed pages taken off` : ""}` });
  return dropped;
}

/** Deletes a document nobody has signed, with its trail and files. Anything signed must be voided instead. */
export async function deleteEnvelope(actor: User, id: string) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env || !canManage(actor, env)) fail("Document not found.");
  if (env!.status === "COMPLETED") fail("A signed document can't be deleted.");
  await withLock(id, async () => {
    if (await anySigned(id)) fail("Someone has signed, so it can't be deleted. Void it instead; its audit trail is kept.");
    const told = ACTIVE.includes(env!.status) ? await db.signSigner.findMany({ where: { envelopeId: id, status: { in: ["SENT", "VIEWED"] } } }) : [];
    const versions = await db.signDocVersion.findMany({ where: { envelopeId: id }, select: { storageKey: true } });
    await db.$transaction([
      db.signField.deleteMany({ where: { envelopeId: id } }),
      db.signSigner.deleteMany({ where: { envelopeId: id } }),
      db.signEvent.deleteMany({ where: { envelopeId: id } }),
      db.signDocVersion.deleteMany({ where: { envelopeId: id } }),
      db.signEnvelope.delete({ where: { id } }),
    ]);
    for (const v of versions) await deleteBytes(v.storageKey).catch((e) => console.error("[sign] couldn't remove a stored PDF", e));
    for (const s of told) await N.signerStopped({ ...env!, reason: "" }, s, "VOIDED");
  });
}

export async function expireIfDue(env: SignEnvelope) {
  const t = await now();
  if (!ACTIVE.includes(env.status) || !env.expiresAt || env.expiresAt > t) return false;
  const moved = await db.signEnvelope.updateMany({ where: { id: env.id, status: { in: [...ACTIVE] } }, data: { status: "EXPIRED", stoppedAt: t } });
  if (!moved.count) return false;
  const x = await db.signEnvelope.findUniqueOrThrow({ where: { id: env.id } });
  await db.signSigner.updateMany({ where: { envelopeId: env.id }, data: { linkNonce: "", sessionNonce: "" } });
  await logEvent(env.id, "EXPIRED", {});
  await stopped(x, "EXPIRED");
  return true;
}

/** The daily job: expire overdue documents, and remind signers pending 3+ days (if switched on). */
export async function dailySign() {
  const t = await now();
  let expired = 0;
  let reminded = 0;
  for (const env of await db.signEnvelope.findMany({ where: { status: { in: ACTIVE }, expiresAt: { lte: t } } })) if (await expireIfDue(env)) expired++;
  if ((await appSettings()).dailyReminders) {
    const cutoff = new Date(t.getTime() - 3 * 86_400_000);
    const recent = new Date(t.getTime() - 20 * 3_600_000);
    for (const env of await db.signEnvelope.findMany({ where: { status: { in: ACTIVE }, sentAt: { lte: cutoff }, OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: recent } }] } })) {
      reminded += await remindNow(null, env.id).catch(() => 0);
    }
  }
  return { expired, reminded };
}

/** Signed on paper instead: the owner uploads the signed scan, which becomes the final document. */
export async function completeOnPaper(actor: User, id: string, file: { bytes: Buffer; mime: string; name: string }, ctx: Ctx = NO_CTX) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env || !canManage(actor, env)) fail("Document not found.");
  if (!["DRAFT", ...ACTIVE].includes(env!.status)) fail("This document is already finished.");
  const okType = file.mime === "application/pdf" || /^image\/(png|jpeg)$/.test(file.mime);
  if (!okType) fail("Upload the signed copy as a PDF, PNG or JPEG.");
  if (file.bytes.length > P.MAX_PDF_BYTES) fail("The scan is over 25 MB.");
  if (file.mime === "application/pdf") await P.checkPdf(file.bytes).catch((e) => fail((e as Error).message));
  const v = await addVersion(id, "PAPER", file.bytes);
  const t = await now();
  const done = await db.signEnvelope.update({ where: { id }, data: { status: "COMPLETED", completionMethod: "PAPER", completedAt: t, finalHash: v.sha256, certNote: "Signed on paper (uploaded scan)" } });
  await db.signSigner.updateMany({ where: { envelopeId: id }, data: { linkNonce: "", sessionNonce: "" } });
  await logEvent(id, "PAPER", { actorId: actor.id, ctx, details: `${file.name.slice(0, 80)} (${file.mime})` });
  await logEvent(id, "COMPLETED", { actorId: actor.id, ctx, details: `on paper, SHA-256 ${v.sha256}` });
  await onStatus(done);
  return done;
}

/** A stored file's type from its first bytes (PDF, PNG or JPEG: the only types accepted). */
export const sniff = (b: Buffer) => (b.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : b[0] === 0x89 && b[1] === 0x50 ? "image/png" : "image/jpeg");

// ---------- cc viewers: download by code (CMP-3) ----------

const VIEWER_KEY = (envId: string, i: number) => `viewer-code:${envId}:${i}`;

export function parseViewerId(id: string) {
  const m = /^(.+)-v(\d{1,2})$/.exec(id);
  return m ? { envelopeId: m[1], index: Number(m[2]) } : null;
}

async function loadViewer(id: string) {
  const v = parseViewerId(id);
  const env = v ? await db.signEnvelope.findUnique({ where: { id: v.envelopeId } }) : null;
  const viewer = env ? viewersOf(env)[v!.index] : undefined;
  if (!env || !viewer || env.status !== "COMPLETED") fail("This download link isn't valid.");
  return { env: env!, viewer: viewer!, index: v!.index };
}

type ViewerCode = { hash: string; exp: number; attempts: number; lockedUntil: number; sent: number[] };

export async function requestViewerCode(id: string, ctx: Ctx = NO_CTX) {
  const { env, viewer, index } = await loadViewer(id);
  const t = (await now()).getTime();
  const row = await db.setting.findUnique({ where: { key: VIEWER_KEY(env.id, index) } });
  const prev: ViewerCode | null = row ? JSON.parse(row.value) : null;
  const sent = (prev?.sent ?? []).filter((x) => t - x < 86_400_000);
  if (sent.filter((x) => t - x < 600_000).length >= CODES_PER_10_MIN) fail("Too many codes requested. Wait 10 minutes and try again.");
  if (sent.length >= CODES_PER_DAY) fail("Too many codes requested today. Try again tomorrow.");
  const code = newCode();
  const value: ViewerCode = { hash: codeHash(id, code), exp: t + CODE_MINUTES * 60_000, attempts: 0, lockedUntil: prev?.lockedUntil ?? 0, sent: [...sent, t] };
  await db.setting.upsert({ where: { key: VIEWER_KEY(env.id, index) }, update: { value: JSON.stringify(value) }, create: { key: VIEWER_KEY(env.id, index), value: JSON.stringify(value) } });
  await N.code(env, { email: viewer.email, name: viewer.name || viewer.email } as SignSigner, code);
  await logEvent(env.id, "CODE_SENT", { ctx, details: `cc ${viewer.email}, for download` });
  return code;
}

export async function verifyViewerCode(id: string, code: string, ctx: Ctx = NO_CTX) {
  const { env, viewer, index } = await loadViewer(id);
  const t = (await now()).getTime();
  const row = await db.setting.findUnique({ where: { key: VIEWER_KEY(env.id, index) } });
  const v: ViewerCode | null = row ? JSON.parse(row.value) : null;
  if (!v?.hash) fail("Ask for a code first.");
  if (v!.lockedUntil > t) fail("Too many wrong codes. Try again in 15 minutes.");
  if (v!.exp <= t) fail("That code has expired. Ask for a new one.");
  const save = (x: ViewerCode) => db.setting.update({ where: { key: VIEWER_KEY(env.id, index) }, data: { value: JSON.stringify(x) } });
  if (codeHash(id, (code ?? "").replace(/\D/g, "")) !== v!.hash) {
    const attempts = v!.attempts + 1;
    if (attempts >= CODE_ATTEMPTS) {
      await save({ ...v!, hash: "", attempts: 0, lockedUntil: t + LOCK_MINUTES * 60_000 });
      fail(`Too many wrong codes. Locked for ${LOCK_MINUTES} minutes.`);
    }
    await save({ ...v!, attempts });
    fail(`That code isn't right. ${CODE_ATTEMPTS - attempts} tries left.`);
  }
  await save({ ...v!, hash: "", attempts: 0 });
  const fin = await db.signDocVersion.findFirst({ where: { envelopeId: env.id, kind: { in: ["FINAL", "PAPER"] } }, orderBy: { seq: "desc" } });
  await logEvent(env.id, "DOWNLOADED", { ctx, details: `final, by cc ${viewer.email}` });
  return { bytes: await versionBytes(fin!), env };
}

// ---------- reading ----------

export async function accessFor(actor: User, id: string) {
  const env = await db.signEnvelope.findUnique({ where: { id } });
  if (!env) return null;
  const signers = await db.signSigner.findMany({ where: { envelopeId: id }, orderBy: { order: "asc" } });
  const role = envelopeRole(actor, env, signers);
  return role ? { env, signers, role } : null;
}

export async function openEnvelope(actor: User, id: string, ctx: Ctx = NO_CTX) {
  const a = await accessFor(actor, id);
  if (!a) fail("Document not found.");
  await expireIfDue(a!.env);
  const t = await now();
  const recent = await db.signEvent.count({ where: { envelopeId: id, actorId: actor.id, type: "OPENED", at: { gt: new Date(t.getTime() - 10 * 60_000) } } });
  if (!recent) await logEvent(id, "OPENED", { actorId: actor.id, ctx });
  return (await accessFor(actor, id))!;
}

export async function fileForStaff(actor: User, id: string, which: "current" | "final" | "original", ctx: Ctx = NO_CTX) {
  const a = await accessFor(actor, id);
  if (!a) fail("Document not found.");
  if (which === "original" && a!.role === "signer") fail("Document not found.");
  const v =
    which === "original"
      ? await db.signDocVersion.findFirst({ where: { envelopeId: id, kind: "ORIGINAL" }, orderBy: { seq: "desc" } })
      : which === "final"
        ? await db.signDocVersion.findFirst({ where: { envelopeId: id, kind: { in: ["FINAL", "PAPER"] } }, orderBy: { seq: "desc" } })
        : await latestVersion(id);
  if (!v) fail("That file isn't available yet.");
  if (which !== "current" || a!.env.status === "COMPLETED") await logEvent(id, "DOWNLOADED", { actorId: actor.id, ctx, details: which });
  return { bytes: await versionBytes(v!), env: a!.env, version: v! };
}

export async function fileForSigner(signerId: string) {
  const { env } = await loadSigner(signerId);
  const v = await latestVersion(env.id);
  return { bytes: await versionBytes(v!), env };
}

export async function finalForSigner(signerId: string, ctx: Ctx = NO_CTX) {
  const { env, signer } = await loadSigner(signerId);
  if (env.status !== "COMPLETED") fail("The document isn't completed yet.");
  const v = await db.signDocVersion.findFirst({ where: { envelopeId: env.id, kind: { in: ["FINAL", "PAPER"] } }, orderBy: { seq: "desc" } });
  await logEvent(env.id, "DOWNLOADED", { signerId: signer.id, ctx, details: "final, by signer" });
  return { bytes: await versionBytes(v!), env };
}

export type ListTab = "me" | "others" | "completed" | "drafts" | "all";

/** Ready-PDF documents (SND-6) this user may see. Agreements have their own list. */
export async function listFor(actor: User, tab: ListTab, q = "", status = "") {
  for (const env of await db.signEnvelope.findMany({ where: { status: { in: ACTIVE }, expiresAt: { lte: await now() } } })) await expireIfDue(env);
  const envs = await db.signEnvelope.findMany({ where: { source: "UPLOAD" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 1000 });
  const signers = await db.signSigner.findMany({ where: { envelopeId: { in: envs.map((e) => e.id) } }, orderBy: { order: "asc" } });
  const by = new Map<string, SignSigner[]>();
  for (const s of signers) by.set(s.envelopeId, [...(by.get(s.envelopeId) ?? []), s]);
  const needle = q.trim().toLowerCase();
  const out = [];
  for (const env of envs) {
    const ss = by.get(env.id) ?? [];
    const role = envelopeRole(actor, env, ss);
    if (!role) continue;
    const mine = ss.find((s) => s.userId === actor.id || s.email.toLowerCase() === actor.email.toLowerCase());
    const turn = ACTIVE.includes(env.status) ? currentTurn(env, ss) : [];
    const myTurn = !!mine && turn.some((s) => s.id === mine.id);
    const inTab =
      tab === "me" ? myTurn : tab === "others" ? env.ownerId === actor.id && ACTIVE.includes(env.status) : tab === "completed" ? env.status === "COMPLETED" : tab === "drafts" ? env.ownerId === actor.id && env.status === "DRAFT" : true;
    if (!inTab) continue;
    if (status && env.status !== status) continue;
    if (needle && !`${env.title} ${ss.map((s) => `${s.name} ${s.email} ${s.company}`).join(" ")}`.toLowerCase().includes(needle)) continue;
    out.push({ env, signers: ss, role, myTurn, mine });
  }
  return out;
}

/** Verify page: does this file match a completed document's final PDF (or any stored version)? */
export async function verifyFile(actor: User | null, bytes: Buffer, ctx: Ctx = NO_CTX) {
  const hash = P.sha256(bytes);
  const certificate = P.checkCertificate(bytes);
  const final = await db.signEnvelope.findFirst({ where: { finalHash: hash, status: "COMPLETED" } });
  if (final) {
    await logEvent(final.id, "VERIFIED", { actorId: actor?.id ?? null, ctx, details: "final PDF matched" });
    const signers = await db.signSigner.findMany({ where: { envelopeId: final.id }, orderBy: { order: "asc" } });
    const visible = actor ? !!envelopeRole(actor, final, signers) : false;
    return { hash, match: "FINAL" as const, envelope: { id: final.id, title: visible ? final.title : "(a completed agreement)", completedAt: final.completedAt, signers: visible ? signers.map((s) => s.typedName || s.name) : [], visible }, certificate };
  }
  const v = await db.signDocVersion.findFirst({ where: { sha256: hash } });
  return { hash, match: v ? ("INTERMEDIATE" as const) : ("NONE" as const), envelope: null, certificate };
}

export async function auditTrail(actor: User, id: string, ctx: Ctx = NO_CTX) {
  const a = await accessFor(actor, id);
  if (!a || !canManage(actor, a.env)) fail("Document not found.");
  const env = a!.env;
  const zone = await tz();
  const events = await db.signEvent.findMany({ where: { envelopeId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  const signers = new Map((await db.signSigner.findMany({ where: { envelopeId: id } })).map((s) => [s.id, s]));
  const users = new Map((await db.user.findMany({ where: { id: { in: events.map((e) => e.actorId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  await logEvent(id, "DOWNLOADED", { actorId: actor.id, ctx, details: "audit trail" });
  const rows = events.map((e) => ({
    at: dateTime(e.at, zone),
    event: e.type,
    who: e.signerId ? `${signers.get(e.signerId)?.name ?? "signer"} <${signers.get(e.signerId)?.email ?? ""}>` : e.actorId ? (users.get(e.actorId) ?? "staff") : "System",
    ip: e.ip,
    details: e.details,
  }));
  return { env, rows, pdf: await P.auditPdf(env.title, id, rows, `times in ${zone}`) };
}
