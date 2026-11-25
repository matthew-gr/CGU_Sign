// Signed links and sessions for Sign. Pure (no database), so the checks are easy to test.
//
//   Signing link   /s/<signerId>.<exp>.<nonce>.<mac>   emailed to external signers. The nonce must match the
//                  signer's current linkNonce, which rotates once they verify their code: the link works once.
//   Session        cookie as_sign = <signerId>.<exp>.<nonce>.<mac>, set after the code is verified, 2 hours.
//   Download       /d/<signerId>.<exp>.<mac>   the final PDF for a signer (they confirm a fresh code first).
//   API file URL   ?exp=&sig=   ten minutes, for GET /api/integrations/esign/envelopes/{id}/pdf.
// Secret: SIGN_SECRET, else AUTH_SECRET; a fixed value only in the local demo.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const LINK_DAYS_MAX = 60;
export const SESSION_MINUTES = 120;
export const DOWNLOAD_DAYS = 30;
export const SESSION_COOKIE = "as_sign";

export function signSecret() {
  const s = process.env.SIGN_SECRET || process.env.AUTH_SECRET || "";
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SIGN_SECRET (or AUTH_SECRET) must be set.");
  return "local-demo-sign-secret";
}

const mac = (purpose: string, data: string, secret = signSecret()) => createHmac("sha256", secret).update(`sign:${purpose}:${data}`).digest("base64url").slice(0, 32);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const b36 = (d: Date) => Math.floor(d.getTime() / 1000).toString(36);
const fromB36 = (s: string) => new Date(parseInt(s, 36) * 1000);

export const newNonce = () => randomBytes(9).toString("base64url");

export type Check<T> = { ok: true; value: T } | { ok: false; reason: "invalid" | "expired" | "used"; signerId?: string };

function make(purpose: string, parts: string[]) {
  const data = parts.join(".");
  return `${data}.${mac(purpose, data)}`;
}

function read(purpose: string, token: string, n: number): { parts: string[] } | null {
  const bits = (token ?? "").split(".");
  if (bits.length !== n + 1 || bits.some((b) => !/^[\w-]{1,64}$/.test(b))) return null;
  const data = bits.slice(0, n).join(".");
  return same(bits[n], mac(purpose, data)) ? { parts: bits.slice(0, n) } : null;
}

// ---------- signing links ----------

export const signingToken = (signerId: string, nonce: string, expiresAt: Date) => make("link", [signerId, b36(expiresAt), nonce]);

/** Tampered -> invalid; past expiry -> expired; nonce no longer current -> used. */
export function readSigningToken(token: string, now: Date, currentNonce: (signerId: string) => string | null): Check<{ signerId: string }> {
  const r = read("link", token, 3);
  if (!r) return { ok: false, reason: "invalid" };
  const [signerId, exp, nonce] = r.parts;
  if (fromB36(exp).getTime() <= now.getTime()) return { ok: false, reason: "expired", signerId };
  const cur = currentNonce(signerId);
  if (!cur || !same(cur, nonce)) return { ok: false, reason: "used", signerId };
  return { ok: true, value: { signerId } };
}

/** The signer id named by a link with a good signature, whatever its state (for "Email me a new link"). */
export function signerOfToken(token: string): string | null {
  return read("link", token, 3)?.parts[0] ?? null;
}

// ---------- the signer's session ----------

export const sessionValue = (signerId: string, nonce: string, now: Date) => make("session", [signerId, b36(new Date(now.getTime() + SESSION_MINUTES * 60_000)), nonce]);

export function readSession(value: string | undefined, now: Date, currentNonce: (signerId: string) => string | null): string | null {
  const r = read("session", value ?? "", 3);
  if (!r) return null;
  const [signerId, exp, nonce] = r.parts;
  if (fromB36(exp).getTime() <= now.getTime()) return null;
  const cur = currentNonce(signerId);
  return cur && same(cur, nonce) ? signerId : null;
}

// ---------- download links ----------

export const downloadToken = (signerId: string, now: Date) => make("download", [signerId, b36(new Date(now.getTime() + DOWNLOAD_DAYS * 86_400_000))]);

export function readDownloadToken(token: string, now: Date): Check<{ signerId: string }> {
  const r = read("download", token, 2);
  if (!r) return { ok: false, reason: "invalid" };
  const [signerId, exp] = r.parts;
  if (fromB36(exp).getTime() <= now.getTime()) return { ok: false, reason: "expired", signerId };
  return { ok: true, value: { signerId } };
}

// ---------- short-lived file URLs (API) ----------

export function fileUrlParams(envelopeId: string, now: Date, minutes = 10) {
  const exp = b36(new Date(now.getTime() + minutes * 60_000));
  return { exp, sig: mac("file", `${envelopeId}.${exp}`), expiresAt: fromB36(exp) };
}

export function checkFileUrl(envelopeId: string, exp: string | null, sig: string | null, now: Date) {
  if (!exp || !sig || !/^[a-z0-9]{1,12}$/.test(exp)) return false;
  if (fromB36(exp).getTime() <= now.getTime()) return false;
  return same(sig, mac("file", `${envelopeId}.${exp}`));
}

