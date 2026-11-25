// A cc viewer's download: the signed download link plus the emailed code, checked here (CMP-3).
import { now } from "@/lib/clock";
import { clientIp } from "@/lib/ratelimit";
import { parseViewerId, SignError, verifyViewerCode } from "@/lib/sign/core";
import { readDownloadToken } from "@/lib/sign/tokens";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = readDownloadToken(token, await now());
  if (!r.ok || !parseViewerId(r.value.signerId)) return new Response("This link isn't valid or has expired.", { status: 403 });
  const fd = await req.formData();
  try {
    const f = await verifyViewerCode(r.value.signerId, String(fd.get("code") ?? ""), { ip: clientIp(req.headers), ua: req.headers.get("user-agent") ?? "" });
    const name = `${f.env.title.replace(/[^\w .()-]/g, "_").slice(0, 80)} (signed).pdf`;
    return new Response(new Uint8Array(f.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });
  } catch (e) {
    const msg = e instanceof SignError ? e.message : "Couldn't check the code.";
    return new Response(`${msg} Go back and try again.`, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
