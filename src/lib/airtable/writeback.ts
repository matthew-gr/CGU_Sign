// AIR-7: optional write-back of an agreement's status, dates and link into the lead's Airtable record. Each write is a
// queued row retried with backoff (1 min, 5 min, 30 min, 2 h, 12 h, 24 h). A failure is shown on the agreement page and
// emailed to Admins at most daily; it never blocks signing.
import { db } from "../db";
import { now } from "../clock";
import { appUrl, sendEmail } from "../email";
import { appSettings } from "../settings";
import { updateRecord } from "./client";
import { connection, token, type WriteBackMap } from "./connection";

export const BACKOFF_MIN = [1, 5, 30, 120, 720, 1440];

export const STATUS_TEXT: Record<string, string> = {
  SENT: "Sent",
  VIEWED: "Viewed",
  PARTIALLY_SIGNED: "Partly signed",
  COMPLETED: "Signed",
  DECLINED: "Declined",
  VOIDED: "Voided",
  EXPIRED: "Expired",
  DRAFT: "Draft",
};

/** Queue a write for an agreement's new state. Does nothing when write-back is off. */
export async function queueWrite(a: { id: string; recordId: string }, state: { status: string; sentAt?: Date | null; signedAt?: Date | null }) {
  const c = await connection();
  if (!c?.writeBack || !a.recordId) return;
  const map = JSON.parse(c.writeBackMap || "{}") as WriteBackMap;
  const fields: Record<string, unknown> = {};
  if (map.status) fields[map.status] = STATUS_TEXT[state.status] ?? state.status;
  if (map.sentAt && state.sentAt) fields[map.sentAt] = state.sentAt.toISOString();
  if (map.signedAt && state.signedAt) fields[map.signedAt] = state.signedAt.toISOString();
  if (map.link) fields[map.link] = `${appUrl()}/agreements/${a.id}`;
  if (!Object.keys(fields).length) return;
  const t = await now();
  const row = await db.airtableWrite.create({ data: { agreementId: a.id, recordId: a.recordId, fields: JSON.stringify(fields), nextAt: t, createdAt: t } });
  await deliver(row.id);
}

async function deliver(id: string) {
  const row = await db.airtableWrite.findUnique({ where: { id } });
  if (!row || row.doneAt) return;
  const c = await connection();
  const t = await now();
  if (!c?.writeBack) {
    await db.airtableWrite.update({ where: { id }, data: { nextAt: null, lastError: "Write-back was switched off; not sent" } });
    return;
  }
  // An older write for the same agreement that's still pending would overwrite this one later: drop it.
  await db.airtableWrite.updateMany({ where: { agreementId: row.agreementId, doneAt: null, createdAt: { lt: row.createdAt }, id: { not: id } }, data: { nextAt: null, lastError: "Replaced by a newer status" } });
  const attempts = row.attempts + 1;
  try {
    await updateRecord(await token(), c.baseId, c.tableId, row.recordId, JSON.parse(row.fields));
    await db.airtableWrite.update({ where: { id }, data: { attempts, doneAt: t, lastError: "", nextAt: null } });
  } catch (e) {
    const wait = BACKOFF_MIN[attempts - 1];
    const msg = (e as Error).message.slice(0, 500);
    await db.airtableWrite.update({ where: { id }, data: { attempts, lastError: msg, nextAt: wait ? new Date(t.getTime() + wait * 60_000) : null } });
    if (wait && wait <= 30) setTimeout(() => void deliver(id).catch(() => undefined), wait * 60_000).unref?.();
  }
}

/** Retry whatever is due (the daily job and agreement activity). */
export async function deliverDue() {
  const t = await now();
  const due = await db.airtableWrite.findMany({ where: { doneAt: null, nextAt: { lte: t } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 50 });
  for (const w of due) await deliver(w.id).catch(() => undefined);
  return due.length;
}

/** The latest write for an agreement, for its page: null, ok, pending or failed. */
export async function writeState(agreementId: string) {
  const w = await db.airtableWrite.findFirst({ where: { agreementId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!w) return null;
  return { done: !!w.doneAt, attempts: w.attempts, error: w.lastError, nextAt: w.nextAt, gaveUp: !w.doneAt && !w.nextAt };
}

/** Daily: tell Admins when write-backs are failing (at most once a day, from the daily job). */
export async function reportFailures() {
  const t = await now();
  const since = new Date(t.getTime() - 86_400_000);
  const failing = await db.airtableWrite.count({ where: { doneAt: null, attempts: { gt: 0 }, createdAt: { gt: new Date(t.getTime() - 7 * 86_400_000) }, lastError: { not: "" }, NOT: { lastError: { startsWith: "Replaced" } } } });
  if (!failing) return 0;
  const last = await db.airtableWrite.findFirst({ where: { doneAt: null, lastError: { not: "" }, createdAt: { gt: since } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const s = await appSettings();
  const admins = await db.user.findMany({ where: { role: "ADMIN", active: true } });
  for (const a of admins)
    await sendEmail({
      to: { email: a.email, name: a.name },
      subject: `Airtable updates are failing (${failing})`,
      body: `${failing} agreement status update${failing === 1 ? "" : "s"} couldn't be written to Airtable in the last week. Signing isn't affected.${last?.lastError ? `\n\nLatest error: ${last.lastError}` : ""}\n\nCheck the connection in ${s.productName} → Settings → Airtable.`,
      link: "/settings/airtable",
      linkLabel: "Open Airtable settings",
    });
  return failing;
}
