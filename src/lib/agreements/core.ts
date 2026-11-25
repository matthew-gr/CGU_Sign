// Agreements (FRD §8, §9): a template version + an Airtable lead. Filled deterministically from the field mapping; a
// person (or Grok, through the same functions) supplies what's missing; the PDF is generated and sent through Sign.
// No AI writes contract text: values only go into named fields and section switches.
import type { Agreement, TemplateField, User } from "@prisma/client";
import { db } from "../db";
import { now } from "../clock";
import { readBytes, saveBytes } from "../file/storage";
import { appSettings } from "../settings";
import { fillTemplate } from "../templates/engine";
import { parseValue, formatValue, type FieldType, type Value } from "../templates/format";
import { scanOf, versionBytes, versionFull, publishedVersion, type VersionFull } from "../templates/core";
import { toPdf, PdfUnavailable } from "../templates/pdf";
import { convert } from "../airtable/convert";
import { lead as fetchLead } from "../airtable/connection";
import type { AirtableRecord, AirtableTable } from "../airtable/client";
import * as S from "../sign/core";
import { EMAIL } from "../sign/core";
import { endOfDayIn } from "../tz";

export class AgreementError extends Error {}
const fail = (m: string): never => {
  throw new AgreementError(m);
};

export type Source = "AIRTABLE" | "FIXED" | "DEFAULT" | "TYPED" | "OVERRIDE";
export type StoredValue = { value: Value; source: Source; airtableField?: string; original?: Value; error?: string };
export type Party = { signer: number; role: string; source: "LEAD" | "SIGNATORY" | "TYPED"; name: string; email: string; company: string };

const parse = <T>(s: string, d: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};
export const valuesOf = (a: Pick<Agreement, "values">) => parse<Record<string, StoredValue>>(a.values, {});
export const switchesOf = (a: Pick<Agreement, "switches">) => parse<Record<string, boolean>>(a.switches, {});
export const partiesOf = (a: Pick<Agreement, "parties">) => parse<Party[]>(a.parties, []);

const isAdmin = (u: Pick<User, "role">) => u.role === "ADMIN";
export const canSee = (u: Pick<User, "id" | "role">, a: Pick<Agreement, "ownerId">) => a.ownerId === u.id || isAdmin(u);

export async function load(actor: User, id: string) {
  const a = await db.agreement.findUnique({ where: { id } });
  if (!a || !canSee(actor, a)) fail("Agreement not found.");
  return a!;
}

async function editable(actor: User, id: string) {
  const a = await load(actor, id);
  if (a.status !== "DRAFT") fail("This agreement has been sent. To change it, revise it first (only while nobody has signed).");
  return a;
}

// ---------- reading Airtable into values (FIL-1, AIR-4, AIR-6) ----------

const cellText = (v: unknown) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.map((x) => (typeof x === "object" && x && "name" in x ? (x as { name: string }).name : String(x))).join(", ") : typeof v === "object" ? "" : String(v));

function fromAirtable(v: VersionFull, table: AirtableTable | null, rec: AirtableRecord | null, zone: string) {
  const out: Record<string, StoredValue> = {};
  const switches: Record<string, boolean> = {};
  for (const f of v.fields) {
    const type = f.type as FieldType;
    let sv: StoredValue = { value: null, source: "DEFAULT" };
    if (f.source === "AIRTABLE" && table && rec) {
      const af = table.fields.find((x) => x.id === f.airtableId);
      const c = convert(af, rec.fields[f.airtableId], type, zone);
      sv = { value: c.value, source: "AIRTABLE", airtableField: af?.name ?? f.airtableId, ...(c.error ? { error: c.error } : {}) };
    } else if (f.source === "FIXED") {
      const p = parseValue(type, f.defaultVal);
      sv = "error" in p ? { value: null, source: "FIXED", error: `the fixed value ${p.error}` } : { value: p.value, source: "FIXED" };
    }
    // Defaults fill anything still empty (except Airtable values that failed to convert, which stay flagged).
    if ((sv.value === null || sv.value === "") && !sv.error && f.defaultVal && f.source !== "FIXED") {
      const p = parseValue(type, f.defaultVal);
      if (!("error" in p)) sv = { value: p.value, source: "DEFAULT", ...(sv.airtableField ? { airtableField: sv.airtableField } : {}) };
    }
    if (f.isSwitch) switches[f.tag] = sv.value === true;
    else out[f.tag] = sv;
  }
  return { values: out, switches };
}

async function partiesFrom(v: VersionFull, table: AirtableTable | null, rec: AirtableRecord | null, prev: Party[] = []): Promise<Party[]> {
  const s = await appSettings();
  const out: Party[] = [];
  for (const p of v.parties) {
    const old = prev.find((x) => x.signer === p.signer);
    if (p.source === "LEAD") {
      const get = (id: string) => (id && rec ? cellText(rec.fields[id]).trim() : "");
      const primary = table && rec ? cellText(rec.fields[table.primaryFieldId]) : "";
      out.push({ signer: p.signer, role: p.role, source: "LEAD", name: get(p.nameField) || primary, email: get(p.emailField).toLowerCase(), company: get(p.companyField) });
    } else if (p.source === "SIGNATORY") {
      const u = p.userId ? await db.user.findUnique({ where: { id: p.userId } }) : null;
      out.push({ signer: p.signer, role: p.role, source: "SIGNATORY", name: u?.name ?? "", email: u?.email ?? "", company: s.companyName });
    } else out.push({ signer: p.signer, role: p.role, source: "TYPED", name: old?.name ?? "", email: old?.email ?? "", company: old?.company ?? "" });
  }
  return out;
}

async function nextReference(t: Date) {
  const s = await appSettings();
  const year = t.getUTCFullYear();
  const row = await db.agreementCounter.upsert({ where: { year }, create: { year, last: 1 }, update: { last: { increment: 1 } } });
  return `${s.referencePrefix}-${year}-${String(row.last).padStart(4, "0")}`;
}

// ---------- the view of an agreement's fields (FIL-1, FIL-2, FIL-4) ----------

export type FieldView = {
  tag: string;
  label: string;
  type: FieldType;
  required: boolean;
  help: string;
  min: number | null;
  max: number | null;
  locked: boolean;
  mapping: string; // AIRTABLE | FIXED | ASK
  value: Value;
  display: string;
  source: Source;
  airtableField?: string;
  original?: Value;
  error?: string;
  needed: boolean; // shown in the PDF with the current switches
  missing: boolean; // needed, required and empty (or invalid)
};
export type SwitchView = { tag: string; label: string; help: string; on: boolean };

/** Is a field printed with these switches? (Fields only inside switched-off sections aren't asked for.) */
function printed(inSections: string[], switches: Record<string, boolean>) {
  if (!inSections.length) return true;
  return inSections.some((s) => (s.startsWith("!") ? switches[s.slice(1)] !== true : switches[s] === true));
}

function rangeError(f: Pick<TemplateField, "min" | "max" | "type" | "label">, v: Value) {
  if (typeof v !== "number") return "";
  const fmt = (n: number) => formatValue(f.type as FieldType, n);
  if (f.min != null && v < f.min) return f.max != null ? `must be between ${fmt(f.min)} and ${fmt(f.max)}` : `must be at least ${fmt(f.min)}`;
  if (f.max != null && v > f.max) return f.min != null ? `must be between ${fmt(f.min)} and ${fmt(f.max)}` : `must be at most ${fmt(f.max)}`;
  return "";
}

export function fieldViews(v: VersionFull, a: Pick<Agreement, "values" | "switches">) {
  const vals = valuesOf(a);
  const sw = switchesOf(a);
  const scan = scanOf(v);
  const fields: FieldView[] = [];
  const switches: SwitchView[] = [];
  for (const f of v.fields) {
    if (f.isSwitch) {
      switches.push({ tag: f.tag, label: f.label, help: f.help, on: sw[f.tag] === true });
      continue;
    }
    const sv = vals[f.tag] ?? { value: null, source: "DEFAULT" as Source };
    const type = f.type as FieldType;
    const needed = printed(scan.fields.find((x) => x.tag === f.tag)?.inSections ?? [], sw);
    const empty = sv.value === null || sv.value === "";
    const range = rangeError(f, sv.value);
    const error = sv.error ?? (range ? range : undefined);
    fields.push({
      tag: f.tag,
      label: f.label,
      type,
      required: f.required,
      help: f.help,
      min: f.min,
      max: f.max,
      locked: f.locked,
      mapping: f.source,
      value: sv.value,
      display: formatValue(type, sv.value),
      source: sv.source,
      airtableField: sv.airtableField,
      original: sv.original,
      error,
      needed,
      missing: needed && ((f.required && empty) || !!error),
    });
  }
  return { fields, switches };
}

/** Missing values and party details, by name and label: what Send waits for (FIL-2) and what MCP returns. */
export function missingOf(v: VersionFull, a: Pick<Agreement, "values" | "switches" | "parties">) {
  const { fields } = fieldViews(v, a);
  const out = fields.filter((f) => f.missing).map((f) => ({ tag: f.tag, label: f.label, reason: f.error ?? "needs a value" }));
  for (const p of partiesOf(a)) {
    if (!p.name.trim()) out.push({ tag: `signer${p.signer}.name`, label: `${p.role} name`, reason: "needs a value" });
    if (!EMAIL.test(p.email.trim())) out.push({ tag: `signer${p.signer}.email`, label: `${p.role} email`, reason: p.email ? "isn't a valid email address" : "needs a value" });
  }
  return out;
}

// ---------- creating and editing (FIL-1, FIL-3, FIL-5, FIL-7) ----------

export type ValuesInput = Record<string, unknown>;
export type PartyInput = { signer: number; name?: string; email?: string; company?: string };

/** A new draft agreement from a template (its published version) and a lead. Values given are applied as typed. */
export async function createAgreement(actor: User, input: { templateId?: string; versionId?: string; recordId: string; values?: ValuesInput; switches?: Record<string, unknown>; parties?: PartyInput[] }) {
  const versionId = input.versionId ?? (input.templateId ? (await publishedVersion(input.templateId))?.id : undefined);
  if (!versionId) fail("That template has no published version yet.");
  const v = await versionFull(versionId!);
  if (!v.published) fail("That template version isn't published.");
  if (v.template.archived) fail("That template is archived.");
  if (!input.recordId) fail("Pick a lead.");
  const zone = (await appSettings()).timeZone;
  const { table, rec, summary } = await fetchLead(input.recordId);
  const filled = fromAirtable(v, table, rec, zone);
  const t = await now();
  const a = await db.agreement.create({
    data: {
      reference: await nextReference(t),
      templateVersionId: v.id,
      title: `${v.template.name} - ${summary.label}`.slice(0, 200),
      recordId: rec.id,
      leadLabel: [summary.label, summary.detail].filter(Boolean).join(" · ").slice(0, 200),
      values: JSON.stringify(filled.values),
      switches: JSON.stringify(filled.switches),
      parties: JSON.stringify(await partiesFrom(v, table, rec)),
      ownerId: actor.id,
      createdAt: t,
      updatedAt: t,
    },
  });
  if (input.values || input.switches || input.parties) return setValues(actor, a.id, input.values ?? {}, input.switches ?? {}, input.parties ?? []);
  return a;
}

/**
 * FIL-3/FIL-5: change named fields, switches and party details on a draft. Unknown names and invalid values are refused
 * by name. Changing an Airtable value marks it as overridden (Airtable isn't changed); locked fields can't change.
 */
export async function setValues(actor: User, id: string, values: ValuesInput, switches: Record<string, unknown> = {}, parties: PartyInput[] = []) {
  const a = await editable(actor, id);
  const v = await versionFull(a.templateVersionId);
  const vals = valuesOf(a);
  const sw = switchesOf(a);
  const errors: string[] = [];
  const changes: string[] = [];
  for (const [tag, raw] of Object.entries(values ?? {})) {
    const f = v.fields.find((x) => x.tag === tag && !x.isSwitch);
    if (!f) {
      const sf = v.fields.find((x) => x.tag === tag && x.isSwitch);
      if (sf) switches = { ...switches, [tag]: raw };
      else errors.push(`"${tag}" isn't a field in this template.`);
      continue;
    }
    const p = parseValue(f.type as FieldType, raw);
    if ("error" in p) {
      errors.push(`${f.label} ${p.error}.`);
      continue;
    }
    const range = rangeError(f, p.value);
    if (range) {
      errors.push(`${f.label} ${range}.`);
      continue;
    }
    const cur = vals[tag] ?? { value: null, source: "DEFAULT" as Source };
    if (JSON.stringify(cur.value) === JSON.stringify(p.value) && !cur.error) continue;
    const fromAirtable = cur.source === "AIRTABLE" || cur.source === "OVERRIDE";
    if (fromAirtable && f.locked && cur.value !== null) {
      errors.push(`${f.label} comes from Airtable and is locked; change it in Airtable and refresh.`);
      continue;
    }
    if (fromAirtable && cur.value !== null) {
      const original = cur.source === "OVERRIDE" ? cur.original : cur.value;
      vals[tag] = JSON.stringify(original) === JSON.stringify(p.value) ? { value: p.value, source: "AIRTABLE", airtableField: cur.airtableField } : { value: p.value, source: "OVERRIDE", airtableField: cur.airtableField, original: original ?? null };
      changes.push(`${f.label}: ${formatValue(f.type as FieldType, p.value)} (Airtable had ${formatValue(f.type as FieldType, original ?? null) || "nothing"})`);
    } else {
      vals[tag] = { value: p.value, source: p.value === null ? "DEFAULT" : "TYPED", ...(cur.airtableField ? { airtableField: cur.airtableField } : {}) };
      changes.push(`${f.label}: ${formatValue(f.type as FieldType, p.value) || "(cleared)"}`);
    }
  }
  for (const [tag, raw] of Object.entries(switches ?? {})) {
    const f = v.fields.find((x) => x.tag === tag && x.isSwitch);
    if (!f) {
      errors.push(`"${tag}" isn't an optional section in this template.`);
      continue;
    }
    const p = parseValue("BOOLEAN", raw);
    if ("error" in p) errors.push(`${f.label} must be yes or no.`);
    else if (sw[tag] !== p.value) {
      sw[tag] = p.value === true;
      changes.push(`${f.label}: ${p.value ? "yes" : "no"}`);
    }
  }
  const ps = partiesOf(a);
  for (const pi of parties ?? []) {
    const p = ps.find((x) => x.signer === pi.signer);
    if (!p) {
      errors.push(`There's no signer ${pi.signer} in this template.`);
      continue;
    }
    if (pi.email !== undefined) {
      const e = pi.email.trim().toLowerCase();
      if (e && !EMAIL.test(e)) errors.push(`${p.role} email doesn't look right.`);
      else if (e !== p.email) {
        changes.push(`${p.role} email: ${e} (was ${p.email || "empty"})`);
        p.email = e;
      }
    }
    if (pi.name !== undefined && pi.name.trim() !== p.name) {
      changes.push(`${p.role} name: ${pi.name.trim()}`);
      p.name = pi.name.trim().slice(0, 120);
    }
    if (pi.company !== undefined) p.company = pi.company.trim().slice(0, 120);
  }
  if (errors.length) fail(errors.join(" "));
  const updated = await db.agreement.update({ where: { id }, data: { values: JSON.stringify(vals), switches: JSON.stringify(sw), parties: JSON.stringify(ps), updatedAt: await now() } });
  if (changes.length) await logAgreement(updated, actor, "EDITED", changes.join("; "));
  return updated;
}

/** AIR-6: read Airtable again (drafts only). Overrides and typed values are kept; Airtable values are refreshed. */
export async function refreshFromAirtable(actor: User, id: string) {
  const a = await editable(actor, id);
  const v = await versionFull(a.templateVersionId);
  const zone = (await appSettings()).timeZone;
  const { table, rec, summary } = await fetchLead(a.recordId);
  const fresh = fromAirtable(v, table, rec, zone);
  const old = valuesOf(a);
  const merged: Record<string, StoredValue> = {};
  for (const [tag, sv] of Object.entries(fresh.values)) {
    const o = old[tag];
    if (o && (o.source === "TYPED" || o.source === "OVERRIDE")) merged[tag] = o.source === "OVERRIDE" ? { ...o, original: sv.value } : o;
    else merged[tag] = sv;
  }
  const parties = await partiesFrom(v, table, rec, partiesOf(a));
  // Party details someone typed for TYPED parties are kept (partiesFrom does); lead details come fresh.
  const updated = await db.agreement.update({
    where: { id },
    data: { values: JSON.stringify(merged), parties: JSON.stringify(parties), leadLabel: [summary.label, summary.detail].filter(Boolean).join(" · ").slice(0, 200), updatedAt: await now() },
  });
  await logAgreement(updated, actor, "REFRESHED", "values read again from Airtable");
  return updated;
}

// ---------- generating (SND-1, SND-2) ----------

function plainValues(a: Pick<Agreement, "values">) {
  const out: Record<string, Value> = {};
  for (const [k, sv] of Object.entries(valuesOf(a))) out[k] = sv.value;
  return out;
}

/** Fill the .docx and convert it to PDF. Pure apart from the conversion; the same inputs give the same .docx. */
export async function generate(a: Agreement) {
  const v = await versionFull(a.templateVersionId);
  const docx = fillTemplate(await versionBytes(v), v.fields.filter((f) => !f.isSwitch).map((f) => ({ tag: f.tag, type: f.type as FieldType })), plainValues(a), switchesOf(a));
  try {
    const pdf = await toPdf(docx);
    return { docx, pdf: pdf.bytes, method: pdf.method, version: v };
  } catch (e) {
    if (e instanceof PdfUnavailable) fail("The PDF service isn't available right now, so nothing was generated or sent. Try again in a few minutes.");
    throw e;
  }
}

/** SND-2: the exact PDF that would be sent (with anchors still in it; the preview page paints field boxes). */
export async function preview(actor: User, id: string) {
  const a = await load(actor, id);
  if (a.envelopeId && a.status !== "DRAFT") {
    const f = await S.fileForStaff(actor, a.envelopeId, a.status === "COMPLETED" ? "final" : "current");
    return { pdf: f.bytes, method: "STORED" as const };
  }
  const g = await generate(a);
  return { pdf: g.pdf, method: g.method };
}

// ---------- sending (SND-3, SND-4, SND-5) ----------

export type SendOptions = { message?: string; signBy?: string | Date | null; viewers?: { name: string; email: string }[]; signingOrder?: "SEQUENTIAL" | "PARALLEL" };

/** What will be sent, for a confirmation step (the web form and send_agreement without confirm). */
export async function sendSummary(actor: User, id: string, o: SendOptions = {}) {
  const a = await load(actor, id);
  const v = await versionFull(a.templateVersionId);
  const s = await appSettings();
  const { fields, switches } = fieldViews(v, a);
  const signBy = signByDate(o.signBy, s.timeZone) ?? new Date((await now()).getTime() + s.expiryDays * 86_400_000);
  return {
    reference: a.reference,
    title: a.title,
    template: `${v.template.name} v${v.version}`,
    signers: partiesOf(a).map((p) => ({ order: p.signer, role: p.role, name: p.name, email: p.email })),
    signingOrder: o.signingOrder ?? v.signingOrder,
    signBy: signBy.toISOString().slice(0, 10),
    values: fields.filter((f) => f.needed && f.display).map((f) => ({ label: f.label, value: f.display, source: f.source })),
    sections: switches.map((x) => ({ label: x.label, on: x.on })),
    missing: missingOf(v, a),
  };
}

function signByDate(v: string | Date | null | undefined, zone: string) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = endOfDayIn(String(v).slice(0, 10), zone);
  if (!d) fail("The sign-by date must be a date (YYYY-MM-DD).");
  return d;
}

export async function sendAgreement(actor: User, id: string, o: SendOptions = {}, ctx?: S.Ctx) {
  const a = await editable(actor, id);
  const v = await versionFull(a.templateVersionId);
  const missing = missingOf(v, a);
  if (missing.length) fail(`${missing.length} value${missing.length === 1 ? "" : "s"} still needed: ${missing.map((m) => `${m.label} (${m.reason})`).join(", ")}.`);
  const zone = (await appSettings()).timeZone;
  const signBy = signByDate(o.signBy, zone);
  const g = await generate(a);
  const t = await now();
  const docxKey = await saveBytes(g.docx);
  const docxHash = (await import("node:crypto")).createHash("sha256").update(g.docx).digest("hex");
  const fileName = `${a.reference}.pdf`;
  let envId = a.envelopeId;
  const existing = envId ? await db.signEnvelope.findUnique({ where: { id: envId } }) : null;
  if (existing && existing.status === "DRAFT") {
    // Revised before anyone signed: the same envelope gets the new PDF and goes out as an update.
    await S.replaceDocument(actor, existing.id, { bytes: g.pdf, name: fileName }, ctx);
    await db.signField.deleteMany({ where: { envelopeId: existing.id } });
  } else {
    const env = await S.createEnvelope(actor, { title: a.title, bytes: g.pdf, fileName, source: "AGREEMENT", sourceRef: a.id }, ctx);
    envId = env.id;
  }
  const parties = partiesOf(a);
  await S.setSigners(actor, envId!, parties.map((p) => ({ name: p.name, email: p.email, company: p.company, role: p.role })), o.signingOrder ?? (v.signingOrder as "SEQUENTIAL" | "PARALLEL"));
  if (!(await db.signField.count({ where: { envelopeId: envId! } }))) await S.applyAnchors(actor, envId!);
  await S.setOptions(actor, envId!, { title: a.title, message: o.message ?? "", expiresAt: signBy ?? undefined, viewers: o.viewers ?? [], ...(o.signingOrder ? { signingOrder: o.signingOrder } : {}) });
  await db.agreement.update({ where: { id }, data: { envelopeId: envId, docxKey, docxHash, frozenAt: t, updatedAt: t } });
  await S.logEvent(envId!, "FILLED", { actorId: actor.id, ctx, details: `${a.reference} from template v${v.version} (${v.sha256.slice(0, 12)}), Airtable record ${a.recordId}; ${describeSources(a)}` });
  await S.sendEnvelope(actor, envId!, ctx);
  return db.agreement.findUniqueOrThrow({ where: { id } });
}

function describeSources(a: Agreement) {
  const counts: Record<string, number> = {};
  for (const sv of Object.values(valuesOf(a))) if (sv.value !== null) counts[sv.source] = (counts[sv.source] ?? 0) + 1;
  const overrides = Object.entries(valuesOf(a)).filter(([, sv]) => sv.source === "OVERRIDE").map(([k]) => k);
  return `${Object.entries(counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ") || "no values"}${overrides.length ? `; overridden: ${overrides.join(", ")}` : ""}`;
}

async function logAgreement(a: Agreement, actor: User, type: string, details: string) {
  if (a.envelopeId) await S.logEvent(a.envelopeId, type, { actorId: actor.id, details });
  else console.log(`[agreement ${a.reference}] ${type} by ${actor.email}: ${details}`);
}

// ---------- after sending: through Sign ----------

async function envelopeOf(actor: User, id: string) {
  const a = await load(actor, id);
  if (!a.envelopeId) fail("This agreement hasn't been sent yet.");
  return { a, envId: a.envelopeId! };
}

export async function remind(actor: User, id: string, ctx?: S.Ctx) {
  const { envId } = await envelopeOf(actor, id);
  return S.remindNow(actor, envId, ctx);
}

export async function voidAgreement(actor: User, id: string, reason: string, ctx?: S.Ctx) {
  const a = await load(actor, id);
  if (!a.envelopeId) {
    if (a.status !== "DRAFT") fail("This agreement can't be voided.");
    await db.agreement.update({ where: { id }, data: { status: "VOIDED", updatedAt: await now() } });
    return;
  }
  await S.voidEnvelope(actor, a.envelopeId, reason, ctx);
}

export async function revise(actor: User, id: string, ctx?: S.Ctx) {
  const { envId } = await envelopeOf(actor, id);
  await S.reviseEnvelope(actor, envId, ctx);
}

export async function extend(actor: User, id: string, until: Date, ctx?: S.Ctx) {
  const { envId } = await envelopeOf(actor, id);
  await S.extendExpiry(actor, envId, until, ctx);
}

/** Deletes an agreement nobody has signed (draft or sent), with its envelope. */
export async function deleteAgreement(actor: User, id: string) {
  const a = await load(actor, id);
  if (a.status === "COMPLETED") fail("A signed agreement can't be deleted.");
  if (a.envelopeId) {
    const env = await db.signEnvelope.findUnique({ where: { id: a.envelopeId } });
    if (env) await S.deleteEnvelope(actor, env.id);
  }
  await db.airtableWrite.deleteMany({ where: { agreementId: id } });
  await db.agreement.delete({ where: { id } });
}

export async function paper(actor: User, id: string, file: { bytes: Buffer; mime: string; name: string }, ctx?: S.Ctx) {
  const { envId } = await envelopeOf(actor, id);
  await S.completeOnPaper(actor, envId, file, ctx);
}

/** The final signed PDF (or the latest state while in progress). */
export async function signedFile(actor: User, id: string, ctx?: S.Ctx) {
  const { a, envId } = await envelopeOf(actor, id);
  return S.fileForStaff(actor, envId, a.status === "COMPLETED" ? "final" : "current", ctx);
}

export async function docxFile(actor: User, id: string) {
  const a = await load(actor, id);
  if (!a.docxKey) fail("No Word file has been generated yet.");
  return { bytes: await readBytes(a.docxKey), name: `${a.reference}.docx` };
}

// ---------- lists ----------

export type AgreementFilter = { status?: string; q?: string; since?: Date; lead?: string };

/** A Sender's own agreements; Admins see all. */
export async function listAgreements(actor: User, f: AgreementFilter = {}, take = 200) {
  const q = f.q?.trim();
  const rows = await db.agreement.findMany({
    where: {
      ...(isAdmin(actor) ? {} : { ownerId: actor.id }),
      ...(f.status ? { status: f.status } : {}),
      ...(f.since ? { createdAt: { gte: f.since } } : {}),
      ...(f.lead ? { OR: [{ recordId: f.lead }, { leadLabel: { contains: f.lead, mode: "insensitive" as const } }] } : {}),
      ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" as const } }, { reference: { contains: q, mode: "insensitive" as const } }, { leadLabel: { contains: q, mode: "insensitive" as const } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take,
  });
  return rows;
}

export const STATUS_LABEL: Record<string, string> = { ...S.STATUS_LABEL, VIEWED: "Viewed" };
