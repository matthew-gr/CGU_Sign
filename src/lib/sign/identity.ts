// Proving who a signer is: a 6-digit code emailed to the address the request went to. Valid 10 minutes, 5 wrong tries
// then locked for 15 minutes; at most 3 codes per 10 minutes and 10 a day. Every signer, staff or not, signs this way.
import { createHmac, randomInt } from "node:crypto";
import { signSecret } from "./tokens";

export const CODE_MINUTES = 10;
export const CODE_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const CODES_PER_10_MIN = 3;
export const CODES_PER_DAY = 10;

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
export const codeHash = (signerId: string, code: string) => createHmac("sha256", signSecret()).update(`sign:code:${signerId}:${code}`).digest("hex");

/** "Chrome on Windows"-style label for the certificate (never the raw string alone). */
export function deviceLabel(ua: string) {
  if (!ua) return "";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const mobile = /Mobile|iPhone|Android/.test(ua) ? " (mobile)" : "";
  return [br, os].filter(Boolean).join(" on ") + mobile || ua.slice(0, 60);
}
