// .docx → PDF (docs/contracts.md §PDF). In order:
//   1. Gotenberg (GOTENBERG_URL): LibreOffice in a small private Railway service. Exact Word layout; comments are not
//      exported (LibreOffice's exportNotes is off by default, and we send it as false).
//   2. A local LibreOffice (`soffice`), for developers who have it.
//   3. A draft PDF built from the document's text, only off the hosted site (local demo and tests) or with
//      PDF_DRAFT_ALLOWED=1. Layout is approximate and it says so; never used in production without that switch.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { clean } from "../pdf";
import { docxBodyText } from "./engine";

export type PdfMethod = "GOTENBERG" | "SOFFICE" | "DRAFT";
export type Converted = { bytes: Buffer; method: PdfMethod };

export class PdfUnavailable extends Error {}

export const draftAllowed = () => process.env.PDF_DRAFT_ALLOWED === "1" || process.env.NODE_ENV !== "production";

async function gotenberg(docx: Buffer, url: string): Promise<Buffer> {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(docx)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "contract.docx");
  form.append("exportNotes", "false");
  form.append("exportNotesInMargin", "false");
  const headers: Record<string, string> = {};
  if (process.env.GOTENBERG_USER) headers.Authorization = `Basic ${Buffer.from(`${process.env.GOTENBERG_USER}:${process.env.GOTENBERG_PASSWORD ?? ""}`).toString("base64")}`;
  const res = await fetch(`${url.replace(/\/$/, "")}/forms/libreoffice/convert`, { method: "POST", body: form, headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new PdfUnavailable(`The PDF service returned ${res.status}.`);
  return Buffer.from(await res.arrayBuffer());
}

function sofficePath(): string | null {
  const candidates = [process.env.SOFFICE_PATH, "C:/Program Files/LibreOffice/program/soffice.exe", "/usr/bin/soffice", "/usr/bin/libreoffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function soffice(docx: Buffer, bin: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "gra-contract-"));
  try {
    const src = path.join(dir, "contract.docx");
    await writeFile(src, docx);
    await new Promise<void>((resolve, reject) => execFile(bin, ["--headless", "--convert-to", "pdf", "--outdir", dir, src], { timeout: 120_000 }, (e) => (e ? reject(e) : resolve())));
    return await readFile(path.join(dir, "contract.pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A plain PDF of the document's body text (never the comments), marked as a draft. */
export async function draftPdf(docx: Buffer): Promise<Buffer> {
  const body = docxBodyText(docx);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let page = doc.addPage([595, 842]);
  let y = 790;
  const mark = () => page.drawText("DRAFT PDF (layout approximate; the PDF service isn't configured)", { x: 50, y: 815, size: 7, font, color: rgb(0.6, 0.6, 0.6) });
  mark();
  for (const para of clean(body).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    const flush = () => {
      if (y < 60) {
        page = doc.addPage([595, 842]);
        mark();
        y = 790;
      }
      page.drawText(line, { x: 50, y, size: 10, font });
      y -= 14;
      line = "";
    };
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, 10) > 495 && line) {
        flush();
        line = w;
      } else line = next;
    }
    if (line) flush();
    y -= 6;
  }
  return Buffer.from(await doc.save());
}

/** The best available conversion. Throws PdfUnavailable when none is (hosted, no Gotenberg, no draft switch). */
export async function toPdf(docx: Buffer): Promise<Converted> {
  const url = process.env.GOTENBERG_URL;
  if (url) return { bytes: await gotenberg(docx, url), method: "GOTENBERG" };
  const bin = sofficePath();
  if (bin) return { bytes: await soffice(docx, bin), method: "SOFFICE" };
  if (draftAllowed()) return { bytes: await draftPdf(docx), method: "DRAFT" };
  throw new PdfUnavailable("The PDF service isn't set up (GOTENBERG_URL). The .docx is ready; see docs/contracts.md to switch on PDFs.");
}

export const pdfConfigured = () => !!process.env.GOTENBERG_URL || !!sofficePath();
