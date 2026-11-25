// Encryption at rest for sensitive Employee File values and uploaded documents (AES-256-GCM),
// plus signing for time-limited download links. Server-only.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

let warned = false;
function key(): Buffer {
  const raw = process.env.FILE_ENCRYPTION_KEY;
  if (raw) {
    const k = Buffer.from(raw, "base64");
    if (k.length !== 32) throw new Error("FILE_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
    return k;
  }
  // Hosted (real accounts) must have a real key; locally the demo derives a fixed one.
  if (process.env.NODE_ENV === "production") throw new Error("FILE_ENCRYPTION_KEY is not set; refusing to store sensitive data.");
  if (!warned) console.warn("FILE_ENCRYPTION_KEY not set: using the demo key (local only).");
  warned = true;
  return createHash("sha256").update("agreement-signer-local-key").digest();
}

const PREFIX = "enc:v1:";

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(":").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export function encryptBytes(buf: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptBytes(buf: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

/** What a sensitive value looks like on screen before Reveal, and in the audit log. */
export function mask(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith("[")) {
    try {
      const n = (JSON.parse(plain) as unknown[]).length;
      return `${n} item${n === 1 ? "" : "s"} (hidden)`;
    } catch {
      /* not a list */
    }
  }
  // Only ID-style numbers show their last 3 characters; words (e.g. a marital status) would leak, so they don't.
  const compact = plain.replace(/\s/g, "");
  return /\d/.test(compact) && compact.length > 6 ? `•••• ${compact.slice(-3)}` : "••••";
}

const signingKey = () => createHash("sha256").update(`sign:${process.env.AUTH_SECRET || process.env.FILE_ENCRYPTION_KEY || "agreement-signer-local-key"}`).digest();

export function sign(data: string): string {
  return createHmac("sha256", signingKey()).update(data).digest("base64url");
}

export function verifySignature(data: string, sig: string): boolean {
  const a = Buffer.from(sign(data));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
