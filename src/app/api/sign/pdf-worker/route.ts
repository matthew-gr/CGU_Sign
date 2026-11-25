// The PDF viewer's worker script (pdfjs-dist), served from our own origin so signing pages need no third-party script.
import { readFile } from "node:fs/promises";
import path from "node:path";

let cached: Buffer | null = null;

export async function GET() {
  cached ??= await readFile(path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs"));
  return new Response(new Uint8Array(cached), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
