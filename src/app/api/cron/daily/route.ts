// CMP-7: the daily job. Expires overdue agreements (owners are told), reminds signers pending 3+ days, retries Airtable
// write-backs, and tells Admins when write-backs keep failing. Called by a Railway cron with the CRON_SECRET header.
import { timingSafeEqual } from "node:crypto";
import { dailySign } from "@/lib/sign/core";
import { deliverDue, reportFailures } from "@/lib/airtable/writeback";

export const dynamic = "force-dynamic";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const got = req.headers.get("x-cron-secret") ?? "";
  if (!secret || !same(got, secret)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const sign = await dailySign();
  const retried = await deliverDue();
  const failing = await reportFailures();
  return Response.json({ ok: true, ...sign, airtableRetried: retried, airtableFailing: failing });
}
