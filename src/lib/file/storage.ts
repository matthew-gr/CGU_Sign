// Private, encrypted storage for Employee File uploads. Nothing here is under /public: files are only reachable
// through /api/files/[id] with a signed, expiring URL, and that route re-checks the viewer's permission.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { decryptBytes, encryptBytes, sign, verifySignature } from "./crypto";

// UPLOAD_DIR, else uploads/ on the Railway volume (mounted at /data), else data/uploads locally. Never derived from
// DATABASE_URL: the database is Postgres now, and the files stay on the volume.
const dir = () =>
  path.resolve(process.env.UPLOAD_DIR || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "uploads") : "data/uploads"));

export async function saveBytes(buf: Buffer): Promise<string> {
  await mkdir(dir(), { recursive: true });
  const key = `${Date.now()}-${randomBytes(12).toString("hex")}.bin`;
  await writeFile(path.join(dir(), key), encryptBytes(buf));
  return key;
}

export async function readBytes(key: string): Promise<Buffer> {
  if (!/^[\w.-]+$/.test(key)) throw new Error("Bad storage key");
  return decryptBytes(await readFile(path.join(dir(), key)));
}

/** Removes a stored file (a deleted Sign envelope). A file that is already gone is fine. */
export async function deleteBytes(key: string) {
  if (!/^[\w.-]+$/.test(key)) throw new Error("Bad storage key");
  await rm(path.join(dir(), key), { force: true });
}

const LINK_MINUTES = 10;

/** A download link valid for ten minutes. */
export function signedUrl(uploadId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + LINK_MINUTES * 60;
  return `/api/files/${uploadId}?exp=${exp}&sig=${sign(`${uploadId}.${exp}`)}`;
}

export function checkSignedUrl(uploadId: string, exp: string | null, sig: string | null): boolean {
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
  return verifySignature(`${uploadId}.${exp}`, sig);
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC = "application/msword";

export const ALLOWED_TYPES: Record<string, string[]> = {
  // Documents: contracts, diplomas, RSSB card, work permit, dependents' documents (no ID copies needed).
  RESUME: ["application/pdf", DOCX, DOC],
  HEADSHOT: ["image/jpeg", "image/png", "image/webp"],
  DOC: ["application/pdf", "image/jpeg", "image/png", "image/webp", DOCX],
  // Supporting documents for an entry (education): PDF or a photo/scan. No Word files (macros).
  ENTRY: ["application/pdf", "image/jpeg", "image/png"],
};
export const MAX_BYTES = 10 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * What the file really is, judged by its first bytes, never by its name or the type the browser claims (a renamed file
 * isn't stored or served as a PDF or an image). Word files are containers (zip, or the old OLE format) that other
 * formats share, so those also need the .docx/.doc name or the matching declared type. null: none of the types we keep.
 */
export function sniffType(bytes: Buffer, filename: string, declared = ""): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (bytes.subarray(0, 1024).includes("%PDF-")) return "application/pdf"; // readers accept a short preamble before the header
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (ext === "docx" || declared === DOCX)) return DOCX;
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE) && (ext === "doc" || declared === DOC)) return DOC;
  return null;
}
