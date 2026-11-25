"use server";
// Server actions for Sign. Next.js checks each action's Origin against the host (CSRF), every action re-checks
// access in src/lib/sign/core.ts, and signer actions need a verified signing session (link + emailed code).
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "../db";
import { now } from "../clock";
import { getActor } from "../session";
import { appUrl } from "../email";
import { appSettings } from "../settings";
import { endOfDayIn } from "../tz";
import * as S from "./core";
import { readDownloadToken, readSession, readSigningToken, SESSION_COOKIE, SESSION_MINUTES, signerOfToken } from "./tokens";

export type SignResult = { ok?: boolean; error?: string; message?: string; id?: string };

export async function requestCtx(): Promise<S.Ctx> {
  const h = await headers();
  return { ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "", ua: h.get("user-agent") ?? "" };
}
const ctx = requestCtx;

async function run(fn: () => Promise<unknown>, message?: string): Promise<SignResult> {
  try {
    const out = await fn();
    revalidatePath("/", "layout");
    return { ok: true, message, ...(typeof out === "string" ? { id: out } : {}) };
  } catch (e) {
    if (e instanceof S.SignError) return { error: e.message };
    console.error("[sign]", e);
    return { error: "Something went wrong. Try again; if it keeps failing, tell your administrator." };
  }
}

const field = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const fileOf = async (fd: FormData, k = "file") => {
  const f = fd.get(k);
  if (!(f instanceof File) || !f.size) throw new S.SignError("Choose a file.");
  return { bytes: Buffer.from(await f.arrayBuffer()), mime: f.type || "application/octet-stream", name: f.name };
};
/** A date input ("2026-12-08") as the end of that day in the company's time zone. */
async function dateOf(v: string) {
  if (!v) return null;
  const d = endOfDayIn(v, (await appSettings()).timeZone);
  if (!d) throw new S.SignError("Pick a valid date.");
  return d;
}

// ---------- the owner: drafts ----------

export async function uploadEnvelope(fd: FormData): Promise<SignResult> {
  const me = await getActor();
  return run(async () => {
    const f = await fileOf(fd);
    if (!/^(application\/pdf|image\/(jpeg|png))$/.test(f.mime) && !/\.(pdf|jpe?g|png)$/i.test(f.name)) throw new S.SignError("Upload a PDF, JPG or PNG.");
    const env = await S.createEnvelope(me, { title: field(fd, "title") || f.name.replace(/\.(pdf|jpe?g|png)$/i, ""), bytes: f.bytes, fileName: f.name }, await ctx());
    return env.id;
  });
}

export async function saveSigners(id: string, list: S.SignerInput[], order: "SEQUENTIAL" | "PARALLEL"): Promise<SignResult> {
  const me = await getActor();
  return run(() => S.setSigners(me, id, list, order), "Signers saved.");
}

export async function saveFields(id: string, fields: S.FieldInput[]): Promise<SignResult> {
  const me = await getActor();
  return run(() => S.setFields(me, id, fields), "Fields saved.");
}

export async function placeFromAnchors(id: string): Promise<SignResult> {
  const me = await getActor();
  return run(async () => {
    const n = await S.applyAnchors(me, id);
    if (!n) throw new S.SignError("No anchor tokens for these signers were found in the PDF.");
  }, "Fields placed from the PDF's anchors.");
}

export async function applyTemplateAction(id: string, templateId: string): Promise<SignResult> {
  const me = await getActor();
  return run(() => S.applyTemplate(me, id, templateId), "Layout applied.");
}

export async function saveAsTemplate(id: string, name: string): Promise<SignResult> {
  const me = await getActor();
  return run(() => S.saveTemplate(me, id, name), `Saved as layout "${name}".`);
}

export async function removeTemplate(fd: FormData): Promise<SignResult> {
  const me = await getActor();
  return run(() => S.deleteTemplate(me, field(fd, "templateId")), "Layout deleted.");
}

export async function saveOptions(id: string, o: { title: string; message: string; expires: string; viewers: { name: string; email: string }[]; confidential: boolean }): Promise<SignResult> {
  const me = await getActor();
  return run(async () => S.setOptions(me, id, { title: o.title, message: o.message, expiresAt: await dateOf(o.expires), viewers: o.viewers, confidential: o.confidential }), "Saved.");
}

export async function sendNow(id: string): Promise<SignResult> {
  const me = await getActor();
  return run(async () => S.sendEnvelope(me, id, await ctx()).then(() => id), "Sent for signature.");
}

// ---------- the owner: in flight ----------

export async function voidIt(fd: FormData): Promise<SignResult> {
  const me = await getActor();
  return run(async () => S.voidEnvelope(me, field(fd, "id"), field(fd, "reason"), await ctx()), "Voided. Signers have been told.");
}

export async function extendIt(fd: FormData): Promise<SignResult> {
  const me = await getActor();
  return run(async () => S.extendExpiry(me, field(fd, "id"), (await dateOf(field(fd, "until"))) ?? new Date(0), await ctx()), "Sign-by date extended.");
}

export async function remindIt(fd: FormData): Promise<SignResult> {
  const me = await getActor();
  return run(async () => {
    const n = await S.remindNow(me, field(fd, "id"), await ctx());
    if (!n) throw new S.SignError("Nobody is waiting to sign.");
  }, "Reminder sent with a fresh link.");
}

export async function copyLinkAction(signerId: string): Promise<SignResult & { link?: string }> {
  const me = await getActor();
  let link = "";
  const r = await run(async () => {
    link = await S.copyLink(me, signerId, await ctx());
  });
  return r.ok ? { ...r, link } : r;
}

export async function paperIt(fd: FormData): Promise<SignResult> {
  const me = await getActor();
  return run(async () => S.completeOnPaper(me, field(fd, "id"), await fileOf(fd), await ctx()), "Marked as signed on paper.");
}

export async function reviseIt(fd: FormData): Promise<SignResult> {
  const me = await getActor();
  return run(async () => S.reviseEnvelope(me, field(fd, "id"), await ctx()), "Back in draft. Signers were told the earlier link no longer works.");
}

export async function replacePdf(fd: FormData): Promise<SignResult> {
  const me = await getActor();
  let dropped = 0;
  const r = await run(async () => {
    const f = await fileOf(fd);
    if (f.mime !== "application/pdf" && !/\.pdf$/i.test(f.name)) throw new S.SignError("Upload a PDF.");
    dropped = await S.replaceDocument(me, field(fd, "id"), { bytes: f.bytes, name: f.name }, await ctx());
  });
  return r.ok ? { ...r, message: `Document replaced.${dropped ? ` ${dropped} field${dropped === 1 ? " was" : "s were"} on pages the new PDF doesn't have and ${dropped === 1 ? "was" : "were"} taken off.` : " Check the fields are still in the right places."}` } : r;
}

export async function deleteIt(fd: FormData): Promise<SignResult & { href?: string }> {
  const me = await getActor();
  const r = await run(async () => S.deleteEnvelope(me, field(fd, "id")), "Deleted.");
  return r.ok ? { ...r, href: "/envelopes" } : r;
}

/** Public Verify page: anyone may check a file; details show only to people who can see the agreement. */
export async function verifyUpload(fd: FormData): Promise<SignResult & { verdict?: Awaited<ReturnType<typeof S.verifyFile>> }> {
  const { currentUser } = await import("../session");
  const me = await currentUser();
  try {
    const f = await fileOf(fd);
    if (f.bytes.length > 30 * 1024 * 1024) throw new S.SignError("The file is too large.");
    return { ok: true, verdict: await S.verifyFile(me, f.bytes, await ctx()) };
  } catch (e) {
    return { error: e instanceof S.SignError ? e.message : "Couldn't check that file." };
  }
}

// ---------- signers ----------

/** The signer acting: a verified session from their link. (signerId is accepted for type compatibility and ignored.) */
export type SignerRef = { token?: string; signerId?: string };

async function signerFrom(ref: SignerRef): Promise<string> {
  const t = await now();
  const fromLink = signerOfToken(ref.token ?? "");
  const nonces = new Map<string, string>();
  if (fromLink) nonces.set(fromLink, (await db.signSigner.findUnique({ where: { id: fromLink } }))?.sessionNonce ?? "");
  const id = readSession((await cookies()).get(SESSION_COOKIE)?.value, t, (sid) => nonces.get(sid) || null);
  if (!id || id !== fromLink) throw new S.SignError("Your session has ended. Open the link from your email again.");
  return id;
}

async function setSession(value: string) {
  (await cookies()).set(SESSION_COOKIE, value, { httpOnly: true, secure: appUrl().startsWith("https://"), sameSite: "lax", path: "/", maxAge: SESSION_MINUTES * 60 });
}

async function nonceOf(id: string | null) {
  return id ? ((await db.signSigner.findUnique({ where: { id } }))?.linkNonce ?? "") : "";
}
function linkSigner(token: string, t: Date, nonce: string) {
  const r = readSigningToken(token, t, () => nonce || null);
  if (!r.ok) throw new S.SignError(r.reason === "expired" ? "This link has expired." : r.reason === "used" ? "This link has already been used." : "This link isn't valid.");
  return r.value.signerId;
}
function downloadSigner(token: string, t: Date) {
  const r = readDownloadToken(token, t);
  if (!r.ok) throw new S.SignError(r.reason === "expired" ? "This download link has expired. Ask the sender for the document." : "This link isn't valid.");
  return r.value.signerId;
}

export async function sendCode(token: string, purpose: "SIGN" | "DOWNLOAD" = "SIGN"): Promise<SignResult> {
  return run(async () => {
    const t = await now();
    if (purpose === "DOWNLOAD") {
      const id = downloadSigner(token, t);
      if (S.parseViewerId(id)) await S.requestViewerCode(id, await ctx());
      else await S.requestCode(id, await ctx(), "DOWNLOAD");
      return;
    }
    await S.requestCode(linkSigner(token, t, await nonceOf(signerOfToken(token))), await ctx(), "SIGN");
  }, "We've emailed you a 6-digit code.");
}

export async function checkCode(token: string, code: string, purpose: "SIGN" | "DOWNLOAD" = "SIGN"): Promise<SignResult> {
  return run(async () => {
    const t = await now();
    if (purpose === "DOWNLOAD") {
      const id = downloadSigner(token, t);
      // cc viewers: the code is checked when they download (the download route), not by a session.
      if (S.parseViewerId(id)) throw new S.SignError("Use the Download button with your code.");
      await setSession(await S.verifyCode(id, code, await ctx(), "DOWNLOAD"));
      return;
    }
    await setSession(await S.verifyCode(linkSigner(token, t, await nonceOf(signerOfToken(token))), code, await ctx(), "SIGN"));
  });
}

export async function newLink(token: string): Promise<SignResult> {
  return run(async () => {
    const id = signerOfToken(token);
    if (!id) throw new S.SignError("This link isn't valid.");
    await S.newLinkForSigner(id, await ctx());
  }, "A new link is on its way to your email.");
}

export async function viewed(ref: SignerRef): Promise<SignResult> {
  return run(async () => S.markViewed(await signerFrom(ref), await ctx()));
}

export async function finish(ref: SignerRef, input: S.SigningInput): Promise<SignResult> {
  return run(async () => S.completeSigning(await signerFrom(ref), input, await ctx()), "Signed. Thank you.");
}

export async function decline(ref: SignerRef, reason: string): Promise<SignResult> {
  return run(async () => S.declineSigning(await signerFrom(ref), reason, await ctx()), "You've declined. The sender has been told.");
}

/** Users: create or replace your saved signature from My account. */
export async function saveMySignature(input: { signature: string; initials: string; method: string }): Promise<SignResult> {
  return run(async () => S.saveMySignature(await getActor(), input), "Your signature is saved. It's offered when you sign a document; you choose it each time.");
}

export async function forgetMySignature(): Promise<SignResult> {
  return run(async () => S.forgetSavedSignature((await getActor()).id), "Your saved signature is deleted.");
}
