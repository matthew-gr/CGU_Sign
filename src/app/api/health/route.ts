import { db } from "@/lib/db";
import { pdfConfigured } from "@/lib/templates/pdf";

export const dynamic = "force-dynamic";

/** For Railway's health check and monitoring. Says nothing private. */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, pdf: pdfConfigured() });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
