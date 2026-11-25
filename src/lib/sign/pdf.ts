// The PDF side of Sign (docs/esign.md): checks on uploads, SHA-256 hashes, text anchors ({{sig:1}} …), stamping
// signers' fields onto the page, the completion certificate, and the optional digital certificate (a PDF digital
// signature with the company's .p12). There is no company seal. Server-only, pure
// functions of bytes in and bytes out, so tests can run them without a database.
//
// Field geometry is stored as fractions of the page (x, y from the top-left of the visible page box), so the same
// numbers come out of drag and drop, a saved template or an anchor, and stamp identically.
import { createHash } from "node:crypto";
import forge from "node-forge";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { clean } from "../pdf";

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PAGES = 300;

export const FIELD_TYPES = ["SIGNATURE", "INITIALS", "DATE_SIGNED", "NAME", "TITLE", "TEXT", "CHECKBOX"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_LABEL: Record<FieldType, string> = {
  SIGNATURE: "Signature",
  INITIALS: "Initials",
  DATE_SIGNED: "Date signed",
  NAME: "Name",
  TITLE: "Title",
  TEXT: "Text",
  CHECKBOX: "Checkbox",
};

/** Default box size in points for a new field (drag and drop and anchors use the same sizes). */
export const FIELD_SIZE: Record<FieldType, [number, number]> = {
  SIGNATURE: [170, 42],
  INITIALS: [64, 34],
  DATE_SIGNED: [100, 18],
  NAME: [170, 18],
  TITLE: [170, 18],
  TEXT: [170, 18],
  CHECKBOX: [14, 14],
};

export type Geometry = { page: number; x: number; y: number; width: number; height: number };
export type Placed = Geometry & { type: FieldType; signer: number; required: boolean; label: string };

export class PdfError extends Error {}

export const sha256 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");

/** A PDF we can work with: the magic bytes, the size limit, not encrypted, a sane page count. Returns the page count. */
export async function checkPdf(buf: Buffer): Promise<number> {
  if (!buf.length) throw new PdfError("The file is empty.");
  if (buf.length > MAX_PDF_BYTES) throw new PdfError("The PDF is over 25 MB.");
  if (buf.subarray(0, 1024).indexOf("%PDF-") < 0) throw new PdfError("That file isn't a PDF. Upload a PDF, or a photo or scan as a JPG or PNG.");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf, { updateMetadata: false });
  } catch (e) {
    throw new PdfError(/encrypt/i.test((e as Error).message) ? "The PDF is password-protected. Save an unprotected copy and upload that." : "The PDF can't be read. Try saving it again as a PDF.");
  }
  const n = doc.getPageCount();
  if (!n) throw new PdfError("The PDF has no pages.");
  if (n > MAX_PAGES) throw new PdfError(`The PDF has more than ${MAX_PAGES} pages.`);
  return n;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A JPEG's EXIF orientation (1 = as stored). Phones save photos sideways and record how to turn them for display. */
export function jpegOrientation(b: Buffer): number {
  try {
    for (let i = 2; i + 4 < b.length && b[i] === 0xff; ) {
      const marker = b[i + 1];
      if (marker === 0xda) break; // the image data starts: no more metadata
      const len = b.readUInt16BE(i + 2);
      if (marker === 0xe1 && b.subarray(i + 4, i + 10).toString("latin1") === "Exif\0\0") {
        const t = i + 10; // the TIFF header
        const le = b.subarray(t, t + 2).toString("latin1") === "II";
        const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
        const ifd = t + (le ? b.readUInt32LE(t + 4) : b.readUInt32BE(t + 4));
        for (let k = 0, n = u16(ifd); k < n; k++) if (u16(ifd + 2 + k * 12) === 0x0112) return u16(ifd + 2 + k * 12 + 8);
        return 1;
      }
      i += 2 + len;
    }
  } catch {
    /* damaged metadata: show it as stored */
  }
  return 1;
}

/**
 * A photo or scan (JPG or PNG) becomes a one-page A4 PDF, turned the way the phone recorded and fitted inside the
 * margins, so it can be prepared and signed like any document. Anything else is returned unchanged (and checkPdf
 * decides whether it's a usable PDF).
 */
export async function asPdf(buf: Buffer, name: string): Promise<{ bytes: Buffer; name: string; fromImage: boolean }> {
  const png = buf.subarray(0, 8).equals(PNG_SIGNATURE);
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpg) return { bytes: buf, name, fromImage: false };
  if (buf.length > MAX_PDF_BYTES) throw new PdfError("The image is over 25 MB.");
  const doc = await PDFDocument.create();
  let img: PDFImage;
  try {
    // A fresh copy: pdf-lib's JPEG reader ignores a Buffer's offset, and small Buffers sit inside Node's shared pool.
    const data = new Uint8Array(buf);
    img = png ? await doc.embedPng(data) : await doc.embedJpg(data);
  } catch {
    throw new PdfError("That image can't be read. Save it again as a JPG, PNG or PDF.");
  }
  const o = jpg ? jpegOrientation(buf) : 1;
  const sideways = o >= 5 && o <= 8;
  const [iw, ih] = sideways ? [img.height, img.width] : [img.width, img.height]; // as it should be seen
  const [W, H] = iw > ih ? [842, 595] : [595, 842]; // A4, the image's way round
  const M = 36;
  const k = Math.min((W - 2 * M) / iw, (H - 2 * M) / ih);
  const [w, h] = [img.width * k, img.height * k]; // the stored image, scaled
  const [dw, dh] = sideways ? [h, w] : [w, h]; // the box it fills on the page
  const [bx, by] = [(W - dw) / 2, H - M - dh]; // centred, from the top margin
  // pdf-lib turns an image anticlockwise about its corner at (x, y): place that corner so the turned image fills the box.
  const at =
    o === 3 || o === 4
      ? { x: bx + w, y: by + h, rotate: degrees(180) }
      : o === 5 || o === 6
        ? { x: bx, y: by + dh, rotate: degrees(-90) }
        : o === 7 || o === 8
          ? { x: bx + dw, y: by, rotate: degrees(90) }
          : { x: bx, y: by };
  doc.addPage([W, H]).drawImage(img, { ...at, width: w, height: h });
  return { bytes: Buffer.from(await doc.save()), name: `${name.replace(/\.(jpe?g|png)$/i, "") || "document"}.pdf`, fromImage: true };
}

const box = (p: PDFPage) => p.getCropBox();

/** Fractions of the page → pdf-lib rectangle (origin bottom-left, user space). */
export function toRect(p: PDFPage, g: Geometry) {
  const b = box(p);
  const w = g.width * b.width;
  const h = g.height * b.height;
  return { x: b.x + g.x * b.width, y: b.y + b.height - g.y * b.height - h, width: w, height: h };
}

/** A box of the default size for `type` with its top-left at (x, y) in points from the page's top-left. */
export function sizedGeometry(type: FieldType, page: number, pageW: number, pageH: number, xPt: number, yPt: number): Geometry {
  const [w, h] = FIELD_SIZE[type];
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return { page, x: r(xPt / pageW), y: r(yPt / pageH), width: r(w / pageW), height: r(h / pageH) };
}

// ---------- anchors ----------

export const ANCHOR_RE = /\{\{\s*(sig|initials|date|name|title|text|check)\s*:\s*(\d{1,2})\s*(?::\s*([^}]{0,60}?)\s*)?\}\}/gi;
const ANCHOR_TYPE: Record<string, FieldType> = { sig: "SIGNATURE", initials: "INITIALS", date: "DATE_SIGNED", name: "NAME", title: "TITLE", text: "TEXT", check: "CHECKBOX" };

export type Anchor = Placed & { token: string; cover: { page: number; x: number; y: number; width: number; height: number } };

/** A blank date line: "Date: ________" (US), or "…… /…… /……" (three dotted groups between slashes). */
const DATE_BLANK_RE = /(?<=\bDate\s*:?\s*)_{4,}|[.…_]{2,}[.…_ ]*\/[.…_ ]*[.…_]{2,}[.…_ ]*\/[.…_ ]*[.…_]{2,}/i;

type TextItem = { str: string; transform: number[]; width: number; height: number };

/**
 * Tokens like {{sig:1}} in the PDF's text, where the number is the signer's order. Each becomes a field whose box starts
 * at the token, sized by type, plus the area to cover (in points, pdf-lib space) so the token disappears. Text split
 * across several runs on one line is joined first.
 * A blank date line ("… on ……/……/……") becomes the "Date signed" field of the signer whose {{sig:N}} follows it, so the
 * signing date fills the blank (unless that signer already has a {{date:N}} token).
 */
export async function findAnchors(buf: Uint8Array): Promise<Anchor[]> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const out: Anchor[] = [];
  // Reading order of signature tokens and blank date lines: [page, -baseline].
  const sigs: { at: [number, number]; signer: number }[] = [];
  const blanks: { at: [number, number]; anchor: Omit<Anchor, "signer"> }[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [x0, y0, x1, y1] = page.view as number[];
    const pw = x1 - x0;
    const ph = y1 - y0;
    const content = await page.getTextContent();
    const items = (content.items as unknown[]).filter((i): i is TextItem => typeof (i as TextItem).str === "string" && (i as TextItem).str.length > 0);
    // Lines: same baseline (within 1pt), left to right.
    const lines: TextItem[][] = [];
    for (const it of [...items].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
      const line = lines.find((l) => Math.abs(l[0].transform[5] - it.transform[5]) < 1);
      if (line) line.push(it);
      else lines.push([it]);
    }
    for (const line of lines) {
      line.sort((a, b) => a.transform[4] - b.transform[4]);
      let text = "";
      const segs: { start: number; it: TextItem }[] = [];
      for (const it of line) {
        segs.push({ start: text.length, it });
        text += it.str;
      }
      // x position (points, user space) of character index i on this line.
      const xAt = (i: number) => {
        const s = [...segs].reverse().find((g) => g.start <= i) ?? segs[0];
        const len = s.it.str.length || 1;
        return s.it.transform[4] + (Math.min(i - s.start, len) / len) * s.it.width;
      };
      for (const m of text.matchAll(ANCHOR_RE)) {
        const type = ANCHOR_TYPE[m[1].toLowerCase()];
        const signer = Number(m[2]);
        if (!type || signer < 1) continue;
        const start = m.index ?? 0;
        const end = start + m[0].length;
        const first = segs.find((g) => g.start <= start && start < g.start + g.it.str.length)?.it ?? line[0];
        const fontH = Math.max(Math.hypot(first.transform[2], first.transform[3]), first.height || 0, 6);
        const baseline = first.transform[5];
        const left = xAt(start);
        const right = xAt(end);
        // The box sits on the token's line: its left edge at the token, its bottom just under the baseline.
        const [, h] = FIELD_SIZE[type];
        const topFromTop = y1 - baseline - h + fontH * 0.25;
        if (type === "SIGNATURE") sigs.push({ at: [n, -baseline], signer });
        out.push({
          type,
          signer,
          required: true,
          label: (m[3] ?? "").trim() || (type === "TEXT" || type === "CHECKBOX" ? FIELD_LABEL[type] : ""),
          token: m[0],
          ...sizedGeometry(type, n, pw, ph, left - x0, Math.max(0, topFromTop)),
          cover: { page: n, x: left - 0.5, y: baseline - fontH * 0.3, width: right - left + 1, height: fontH * 1.35 },
        });
      }
      const blank = DATE_BLANK_RE.exec(text);
      if (blank) {
        const start = blank.index;
        const first = segs.find((g) => g.start <= start && start < g.start + g.it.str.length)?.it ?? line[0];
        const fontH = Math.max(Math.hypot(first.transform[2], first.transform[3]), first.height || 0, 6);
        const baseline = first.transform[5];
        const left = xAt(start);
        const right = xAt(start + blank[0].length);
        const [, h] = FIELD_SIZE.DATE_SIGNED;
        // An underscore line stays visible (the date is written on it); dotted groups are painted over.
        const underline = /^_+$/.test(blank[0]);
        blanks.push({
          at: [n, -baseline],
          anchor: {
            type: "DATE_SIGNED",
            required: true,
            label: "",
            token: blank[0],
            ...sizedGeometry("DATE_SIGNED", n, pw, ph, left - x0 + (underline ? 2 : 0), Math.max(0, y1 - baseline - h + fontH * (underline ? 0.55 : 0.25))),
            cover: underline ? { page: n, x: left, y: baseline, width: 0, height: 0 } : { page: n, x: left - 0.5, y: baseline - fontH * 0.3, width: right - left + 1, height: fontH * 1.35 },
          },
        });
      }
    }
  }
  const after = (a: [number, number], b: [number, number]) => b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]);
  const dated = new Set(out.filter((a) => a.type === "DATE_SIGNED").map((a) => a.signer));
  sigs.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  for (const b of blanks) {
    // "Client: {{sig:1}}  Date: ____" on one line belongs to that signer; otherwise the next signature after the blank.
    const next = sigs.find((s) => s.at[0] === b.at[0] && Math.abs(s.at[1] - b.at[1]) < 1) ?? sigs.find((s) => after(b.at, s.at));
    if (!next || dated.has(next.signer)) continue;
    dated.add(next.signer);
    out.push({ ...b.anchor, signer: next.signer });
  }
  await pdf.cleanup?.();
  return out;
}

/** The PDF with every anchor token painted over in white (the "prepared" version signers see). */
export async function hideAnchors(buf: Uint8Array, anchors: Anchor[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  for (const { cover } of anchors.filter((a) => a.cover.width > 0)) doc.getPage(cover.page - 1).drawRectangle({ x: cover.x, y: cover.y, width: cover.width, height: cover.height, color: rgb(1, 1, 1), borderWidth: 0 });
  return doc.save({ useObjectStreams: false });
}

// ---------- stamping ----------

export type StampField = Geometry & { type: FieldType; value: string };
export type StampInput = { fields: StampField[]; signature?: string; initials?: string; name: string; dateText: string };

const png = (dataUrl: string) => {
  const m = (dataUrl ?? "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  return m ? Buffer.from(m[1], "base64") : null;
};

function fitText(font: PDFFont, text: string, maxW: number, maxH: number) {
  let size = Math.min(11, Math.max(6, maxH * 0.72));
  while (size > 5 && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
  return size;
}

/** Draw one signer's completed fields onto the PDF. Deterministic: the same input gives the same bytes. */
export async function stamp(buf: Uint8Array, s: StampInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sigPng = png(s.signature ?? "");
  const iniPng = png(s.initials ?? "");
  let sigImg: PDFImage | null = null;
  let iniImg: PDFImage | null = null;
  if (sigPng) sigImg = await doc.embedPng(sigPng);
  if (iniPng) iniImg = await doc.embedPng(iniPng);
  const ink = rgb(0.07, 0.13, 0.33);
  for (const f of s.fields) {
    const page = doc.getPage(f.page - 1);
    const r = toRect(page, f);
    const img = f.type === "SIGNATURE" ? sigImg : f.type === "INITIALS" ? (iniImg ?? sigImg) : null;
    if (img) {
      const scale = Math.min(r.width / img.width, r.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      // Signatures sit on the left, like ink on a line.
      page.drawImage(img, { x: r.x, y: r.y + (r.height - h) / 2, width: w, height: h });
      continue;
    }
    if (f.type === "CHECKBOX") {
      if (f.value === "true") {
        const m = Math.min(r.width, r.height);
        page.drawLine({ start: { x: r.x + m * 0.15, y: r.y + m * 0.5 }, end: { x: r.x + m * 0.42, y: r.y + m * 0.18 }, thickness: 1.6, color: ink });
        page.drawLine({ start: { x: r.x + m * 0.42, y: r.y + m * 0.18 }, end: { x: r.x + m * 0.9, y: r.y + m * 0.85 }, thickness: 1.6, color: ink });
      }
      continue;
    }
    const text = clean(f.type === "DATE_SIGNED" ? s.dateText : f.type === "NAME" ? s.name : f.value).trim();
    if (!text) continue;
    const size = fitText(font, text, r.width, r.height);
    page.drawText(text, { x: r.x + 1, y: r.y + (r.height - size) / 2 + size * 0.2, size, font, color: ink });
  }
  return doc.save({ useObjectStreams: false });
}

// ---------- the completion certificate ----------

export type CertSigner = {
  order: number;
  name: string;
  email: string;
  company: string;
  auth: string;
  viewedAt: string;
  signedAt: string;
  ip: string;
  device: string;
  consent: string;
  signature?: string;
  role?: string;
};
/** company: shown under the title. timeNote: which zone times are in. */
export type CertInput = { title: string; envelopeId: string; sourceRef: string; originalHash: string; completedAt: string; signers: CertSigner[]; certNote: string; company: string; timeNote: string };

/** The company logo for the certificate (public/brand/logo.png), or null when it isn't there. */
async function brandLogo(doc: PDFDocument) {
  try {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    return await doc.embedPng(new Uint8Array(await readFile(path.join(process.cwd(), "public", "brand", "logo.png"))));
  } catch {
    return null;
  }
}

/** Append the certificate page(s): what was signed, and by whom, how and when. */
export async function appendCertificate(buf: Uint8Array, c: CertInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const serif = await doc.embedFont(StandardFonts.TimesRomanBold);
  // Caregivers United: plum headings, the blue rule; grey #666666 labels.
  const blue = rgb(0x91 / 255, 0x2b / 255, 0x8e / 255);
  const rule = rgb(0x14 / 255, 0x77 / 255, 0xbd / 255);
  const grey = rgb(0.4, 0.4, 0.4);
  const logo = await brandLogo(doc);
  let page = doc.addPage([595, 842]);
  let y = 790;
  const stripe = () => {
    page.drawRectangle({ x: 0, y: 836, width: 612, height: 6, color: rule });
  };
  stripe();
  const line = (label: string, value: string, f: PDFFont = font, size = 9) => {
    if (y < 70) {
      page = doc.addPage([595, 842]);
      stripe();
      y = 790;
    }
    page.drawText(clean(label), { x: 50, y, size: 8.5, font: bold, color: grey });
    // Wrap long values (hashes, consent text) within the column.
    // Line breaks (the multi-paragraph consent text) become spaces: standard fonts can't draw them.
    const words = clean(value).replace(/\s*\n\s*/g, " ").split(/(\s+)/);
    let cur = "";
    const maxW = 360;
    const flush = () => {
      page.drawText(cur.trim(), { x: 185, y, size, font: f });
      y -= size + 4;
      cur = "";
    };
    for (const w of words) {
      if (f.widthOfTextAtSize(cur + w, size) > maxW && cur.trim()) flush();
      // A single unbroken string (a hash) longer than the column: break it.
      let part = w;
      while (f.widthOfTextAtSize(part, size) > maxW) {
        let k = part.length;
        while (k > 1 && f.widthOfTextAtSize(part.slice(0, k), size) > maxW) k--;
        cur += part.slice(0, k);
        flush();
        part = part.slice(k);
      }
      cur += part;
    }
    if (cur.trim()) flush();
  };
  if (logo) {
    const h = 46;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: 545 - w, y: y - 18, width: w, height: h });
  }
  page.drawText("Certificate of completion", { x: 50, y, size: 18, font: serif, color: blue });
  y -= 18;
  page.drawText(clean(`${c.company} - electronic signature record`), { x: 50, y, size: 9, font, color: grey });
  y -= 26;
  line("Document", c.title);
  line("Agreement ID", c.envelopeId, mono);
  if (c.sourceRef) line("Reference", c.sourceRef);
  line("Completed", c.completedAt);
  line("Original SHA-256", c.originalHash, mono, 8);
  line("Digital certificate", c.certNote);
  y -= 8;
  for (const s of c.signers) {
    if (y < 230) {
      page = doc.addPage([595, 842]);
      stripe();
      y = 790;
    }
    page.drawLine({ start: { x: 50, y: y + 6 }, end: { x: 545, y: y + 6 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
    y -= 10;
    page.drawText(clean(`Signer ${s.order}${s.role ? ` (${s.role})` : ""}: ${s.name}`), { x: 50, y, size: 11, font: bold, color: blue });
    const img = png(s.signature ?? "");
    if (img) {
      const im = await doc.embedPng(img);
      const scale = Math.min(140 / im.width, 36 / im.height);
      page.drawImage(im, { x: 405, y: y - 24, width: im.width * scale, height: im.height * scale });
    }
    y -= 16;
    line("Email", s.email);
    if (s.company) line("Company", s.company);
    line("Identity check", s.auth);
    line("Viewed", s.viewedAt);
    line("Signed", s.signedAt);
    line("IP address", s.ip || "-");
    line("Device", s.device || "-");
    line("Consent accepted", s.consent);
    y -= 6;
  }
  y -= 6;
  if (y < 90) {
    page = doc.addPage([595, 842]);
    stripe();
    y = 790;
  }
  for (const t of [
    `${c.timeNote} Each signer was identified as shown and signed under their own control.`,
    "Signed electronically under the U.S. ESIGN Act and the Uniform Electronic Transactions Act.",
    "The SHA-256 of the final PDF is kept on record: any later change to this file is detectable on the Verify page.",
  ]) {
    page.drawText(clean(t), { x: 50, y, size: 8, font, color: grey });
    y -= 12;
  }
  return doc.save({ useObjectStreams: false });
}

/** The audit trail as a PDF (owner's download): every event, in order. */
export async function auditPdf(title: string, envelopeId: string, rows: { at: string; event: string; who: string; ip: string; details: string }[], timeNote = "times in UTC"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([842, 595]);
  let y = 550;
  page.drawText(clean(`Audit trail: ${title}`), { x: 40, y, size: 15, font: bold });
  y -= 16;
  page.drawText(clean(`Agreement ${envelopeId} - ${timeNote}`), { x: 40, y, size: 9, font });
  y -= 22;
  const cols: [string, number][] = [["When", 40], ["Event", 160], ["Who", 270], ["IP", 470], ["Details", 570]];
  const header = () => {
    for (const [h, x] of cols) page.drawText(h, { x, y, size: 8.5, font: bold });
    y -= 14;
  };
  header();
  for (const r of rows) {
    if (y < 40) {
      page = doc.addPage([842, 595]);
      y = 550;
      header();
    }
    const vals = [r.at, r.event, r.who, r.ip, r.details];
    cols.forEach(([, x], i) => {
      let t = clean(vals[i] ?? "");
      const max = (cols[i + 1]?.[1] ?? 800) - x - 6;
      while (t && font.widthOfTextAtSize(t, 8) > max) t = t.slice(0, -1);
      page.drawText(t, { x, y, size: 8, font });
    });
    y -= 12;
  }
  return doc.save();
}

// ---------- the optional digital certificate (CMP-2) ----------

export type CertConfig = { p12: Buffer; password: string } | null;

export function certConfig(): CertConfig {
  const raw = process.env.SIGNING_CERT_P12;
  if (!raw) return null;
  return { p12: Buffer.from(raw, "base64"), password: process.env.SIGNING_CERT_PASSWORD ?? "" };
}

/**
 * A digital signature over the whole final PDF with the company's certificate (PKCS#7 detached, SHA-256, via
 * @signpdf). Any later change to the file invalidates it in Adobe Reader and on the Verify page.
 */
export async function certify(buf: Uint8Array, cfg: NonNullable<CertConfig>, at: Date, company = ""): Promise<Buffer> {
  const [{ pdflibAddPlaceholder }, { P12Signer }, signpdf] = await Promise.all([import("@signpdf/placeholder-pdf-lib"), import("@signpdf/signer-p12"), import("@signpdf/signpdf")]);
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: "Signed electronically by all parties",
    contactInfo: process.env.EMAIL_REPLY_TO || "",
    name: company,
    location: "United States",
    signingTime: at,
    signatureLength: 16_384,
  });
  const withPlaceholder = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signer = new P12Signer(cfg.p12, { passphrase: cfg.password });
  return (signpdf.default ?? signpdf).sign(withPlaceholder, signer, at);
}

export type CertCheck = { present: false } | { present: true; valid: boolean; signer: string; reason: string };

/**
 * Check a PDF's last digital signature: the digest of the signed byte ranges matches, and the signature over the
 * signed attributes verifies with the embedded certificate. (Trust in the certificate itself is up to the reader.)
 */
export function checkCertificate(buf: Buffer): CertCheck {
  const text = buf.toString("latin1");
  const all = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const m = all.at(-1);
  if (!m) return { present: false };
  const [a, b, c, d] = m.slice(1, 5).map(Number);
  if (c + d > buf.length) return { present: true, valid: false, signer: "", reason: "The signed byte ranges don't match the file (it was changed or truncated)." };
  try {
    const gap = text.slice(a + b, c);
    const hex = gap.replace(/[<>\s]/g, "").replace(/(00)+$/, "");
    const der = forge.util.hexToBytes(hex.length % 2 ? hex + "0" : hex);
    const asn = forge.asn1.fromDer(der, { parseAllBytes: false } as never);
    const p7 = forge.pkcs7.messageFromAsn1(asn) as unknown as { certificates: forge.pki.Certificate[]; rawCapture: { signerInfos: forge.asn1.Asn1[] } };
    const info = p7.rawCapture.signerInfos[0].value as forge.asn1.Asn1[];
    const attrsNode = info.find((n) => n.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && n.type === 0);
    const sigNode = info[info.length - 1];
    if (!attrsNode) return { present: true, valid: false, signer: "", reason: "No signed attributes." };
    const signed = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);
    const digest = createHash("sha256").update(signed).digest("binary");
    const attrs = attrsNode.value as forge.asn1.Asn1[];
    const md = attrs.find((at) => forge.asn1.derToOid((at.value as forge.asn1.Asn1[])[0].value as string) === forge.pki.oids.messageDigest);
    const mdValue = md ? (((md.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as string) : "";
    const cert = p7.certificates[0];
    const signerName = String(cert?.subject.getField("CN")?.value ?? "");
    if (mdValue !== digest) return { present: true, valid: false, signer: signerName, reason: "The document changed after it was sealed." };
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const attrDigest = forge.md.sha256.create();
    attrDigest.update(forge.asn1.toDer(set).getBytes());
    const ok = (cert.publicKey as forge.pki.rsa.PublicKey).verify(attrDigest.digest().getBytes(), sigNode.value as string);
    return ok ? { present: true, valid: true, signer: signerName, reason: "The seal is intact." } : { present: true, valid: false, signer: signerName, reason: "The seal's signature doesn't verify." };
  } catch {
    return { present: true, valid: false, signer: "", reason: "The seal can't be read." };
  }
}

/** Page sizes in points (visible box), for the editor and anchors. */
export async function pageSizes(buf: Uint8Array): Promise<{ width: number; height: number }[]> {
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const b = box(p);
    return { width: b.width, height: b.height };
  });
}

/** A one-page signature page with anchors for each signer (contracts whose template has none). */
export async function appendSignaturePage(buf: Uint8Array, signers: { order: number; name: string; role: string }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  let y = 770;
  page.drawText("Signatures", { x: 50, y, size: 15, font: bold });
  y -= 40;
  for (const s of signers) {
    page.drawText(clean(`${s.role}: ${s.name}`), { x: 50, y, size: 10, font: bold });
    y -= 30;
    page.drawText(`{{sig:${s.order}}}`, { x: 50, y, size: 10, font });
    page.drawText(`{{date:${s.order}}}`, { x: 330, y, size: 10, font });
    y -= 14;
    page.drawLine({ start: { x: 50, y }, end: { x: 280, y }, thickness: 0.5 });
    page.drawLine({ start: { x: 330, y }, end: { x: 480, y }, thickness: 0.5 });
    y -= 12;
    page.drawText("Signature", { x: 50, y, size: 8, font });
    page.drawText("Date", { x: 330, y, size: 8, font });
    y -= 50;
  }
  return doc.save({ useObjectStreams: false });
}
