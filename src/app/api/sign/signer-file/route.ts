// GET /api/sign/signer-file?s=<signerId>[&final=1]: the PDF a signer is signing (or, once completed, the final copy).
// Only the signer's verified session cookie (set after their emailed code is confirmed) opens it.
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { now } from "@/lib/clock";
import { fileForSigner, finalForSigner, sniff } from "@/lib/sign/core";
import { readSession, SESSION_COOKIE } from "@/lib/sign/tokens";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("s") ?? "";
  const signer = /^[a-z0-9]{10,40}$/.test(id) ? await db.signSigner.findUnique({ where: { id } }) : null;
  if (!signer) return new Response("Not found", { status: 404 });
  const ctx = { ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "", ua: req.headers.get("user-agent") ?? "" };
  const allowed = readSession((await cookies()).get(SESSION_COOKIE)?.value, await now(), (sid) => (sid === signer.id ? signer.sessionNonce || null : null)) === signer.id;
  if (!allowed) return new Response("Your session has ended. Open the link from your email again.", { status: 401 });
  try {
    const { bytes } = url.searchParams.get("final") ? await finalForSigner(signer.id, ctx) : await fileForSigner(signer.id);
    const mime = sniff(bytes);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": mime, "Content-Disposition": url.searchParams.get("final") ? `attachment; filename="signed-document.${mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg"}"` : "inline", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return new Response("Not available", { status: 404 });
  }
}
