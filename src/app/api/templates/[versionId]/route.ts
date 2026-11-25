// TPL-6 (download the .docx) and TPL-7 (test fill as PDF). Admins only.
import { currentUser } from "@/lib/session";
import { testFill, versionBytes, versionFull } from "@/lib/templates/core";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const me = await currentUser();
  if (!me || me.role !== "ADMIN") return new Response("Not allowed", { status: 403 });
  const { versionId } = await params;
  const kind = new URL(req.url).searchParams.get("kind");
  try {
    const v = await versionFull(versionId);
    if (kind === "test") {
      const r = await testFill(me, versionId);
      return new Response(new Uint8Array(r.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="test-fill-v${v.version}.pdf"`, "Cache-Control": "no-store" } });
    }
    return new Response(new Uint8Array(await versionBytes(v)), {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": `attachment; filename="${v.template.name.replace(/[^\w .()-]/g, "_")} v${v.version}.docx"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
