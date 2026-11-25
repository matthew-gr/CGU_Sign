// Keeps an agreement's status in step with its envelope, and queues the Airtable write-back (AIR-7).
import type { SignEnvelope } from "@prisma/client";
import { db } from "../db";
import { now } from "../clock";
import { queueWrite } from "../airtable/writeback";

export async function onEnvelopeStatus(env: SignEnvelope, event?: "VIEWED") {
  const a = await db.agreement.findUnique({ where: { id: env.sourceRef } });
  if (!a || a.envelopeId !== env.id) return;
  const status = env.status;
  if (status !== a.status) await db.agreement.update({ where: { id: a.id }, data: { status, updatedAt: await now() } });
  // "Viewed" is written to Airtable once, while the agreement is still only sent.
  const written = event === "VIEWED" ? (env.status === "SENT" ? "VIEWED" : null) : status === a.status && status !== "DRAFT" ? null : status;
  if (written && written !== "DRAFT") await queueWrite(a, { status: written, sentAt: env.sentAt, signedAt: env.completedAt });
}
