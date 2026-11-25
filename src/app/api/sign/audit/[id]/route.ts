// GET /api/sign/audit/{id}: the document's audit trail as a PDF (its owner and Admins). The download itself is logged.
import { getActor } from "@/lib/session";
import { auditTrail, SignError } from "@/lib/sign/core";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getActor();
  try {
    const { pdf, env } = await auditTrail(me, id, { ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "", ua: req.headers.get("user-agent") ?? "" });
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="audit-trail-${env.id}.pdf"`, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return new Response(e instanceof SignError ? e.message : "Not found", { status: 404 });
  }
}
