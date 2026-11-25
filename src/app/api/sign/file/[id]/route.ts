// GET /api/sign/file/{id}?which=current|final|original[&download=1]: a document's PDF for signed-in users who may see
// it (src/lib/sign/config.ts). Downloads of finished documents are logged.
import { getActor } from "@/lib/session";
import { fileForStaff, SignError, sniff } from "@/lib/sign/core";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const which = (["current", "final", "original"] as const).find((w) => w === url.searchParams.get("which")) ?? "current";
  const me = await getActor();
  try {
    const ctx = { ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "", ua: req.headers.get("user-agent") ?? "" };
    const { bytes, env } = await fileForStaff(me, id, which, ctx);
    const mime = sniff(bytes);
    const name = `${env.title.replace(/[^\w .()-]/g, "_").slice(0, 80)}${which === "final" ? " (signed)" : ""}.${mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg"}`;
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": mime, "Content-Disposition": `${url.searchParams.get("download") ? "attachment" : "inline"}; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    return new Response(e instanceof SignError ? e.message : "Not found", { status: 404 });
  }
}
