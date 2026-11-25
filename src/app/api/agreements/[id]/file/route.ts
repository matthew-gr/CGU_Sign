// Agreement PDFs. Two ways in:
//   - signed in (the web app): ?kind=preview|signed|docx, with the usual access checks;
//   - a short-lived signed link from an MCP tool (get_agreement, download_signed): ?kind=&exp=&sig=, 10 minutes.
import { db } from "@/lib/db";
import { now } from "@/lib/clock";
import { currentUser } from "@/lib/session";
import { checkFileUrl } from "@/lib/sign/tokens";
import * as A from "@/lib/agreements/core";
import { fileForStaff, logEvent } from "@/lib/sign/core";

export const dynamic = "force-dynamic";

const pdf = (bytes: Buffer | Uint8Array, name: string, inline = true) =>
  new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = new URL(req.url);
  const kind = u.searchParams.get("kind") ?? "preview";
  const exp = u.searchParams.get("exp");
  const sig = u.searchParams.get("sig");
  try {
    if (exp || sig) {
      if (!checkFileUrl(`${kind}:${id}`, exp, sig, await now())) return new Response("This link has expired. Ask for a new one.", { status: 403 });
      const a = await db.agreement.findUnique({ where: { id } });
      const owner = a ? await db.user.findUnique({ where: { id: a.ownerId } }) : null;
      if (!a || !owner) return new Response("Not found", { status: 404 });
      if (kind === "signed") {
        if (!a.envelopeId || a.status !== "COMPLETED") return new Response("Not signed yet", { status: 404 });
        const f = await fileForStaff(owner, a.envelopeId, "final");
        await logEvent(a.envelopeId, "DOWNLOADED", { details: "final, by a connector link" });
        return pdf(f.bytes, `${a.reference} (signed).pdf`);
      }
      const p = await A.preview(owner, id);
      return pdf(p.pdf, `${a.reference} (preview).pdf`);
    }
    const me = await currentUser();
    if (!me) return new Response("Sign in required", { status: 401 });
    if (kind === "docx") {
      const f = await A.docxFile(me, id);
      return new Response(new Uint8Array(f.bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": `attachment; filename="${f.name}"`, "Cache-Control": "private, no-store" } });
    }
    const a = await A.load(me, id);
    if (kind === "signed") {
      const f = await A.signedFile(me, id);
      return pdf(f.bytes, `${a.reference}${a.status === "COMPLETED" ? " (signed)" : ""}.pdf`, u.searchParams.get("download") !== "1");
    }
    const p = await A.preview(me, id);
    return pdf(p.pdf, `${a.reference} (preview).pdf`);
  } catch (e) {
    return new Response((e as Error).message || "Not available", { status: e instanceof A.AgreementError ? 404 : 500 });
  }
}
