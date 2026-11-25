// The one Airtable connection (AIR-1, AIR-2, AIR-7). The token is stored encrypted and never shown again; Settings shows
// only which base and table, and when it was last checked. Table schemas are cached for 5 minutes.
import type { User } from "@prisma/client";
import { db } from "../db";
import { now } from "../clock";
import { decrypt, encrypt } from "../file/crypto";
import { AirtableError, getRecord, listBases, listTables, searchRecords, type AirtableRecord, type AirtableTable } from "./client";

export type WriteBackMap = { status?: string; sentAt?: string; signedAt?: string; link?: string };

export async function connection() {
  return db.airtableConnection.findUnique({ where: { id: "default" } });
}

export async function token(): Promise<string> {
  const c = await connection();
  return c?.tokenEnc ? decrypt(c.tokenEnc) : "";
}

const adminOnly = (u: Pick<User, "role">) => {
  if (u.role !== "ADMIN") throw new AirtableError("Only an Admin can change the Airtable connection.");
};

/** Save a new token after checking it works. Returns the bases it can see. */
export async function saveToken(actor: User, raw: string) {
  adminOnly(actor);
  const t = raw.trim();
  if (!/^pat[A-Za-z0-9]{10,}\.[A-Za-z0-9]{20,}$/.test(t)) throw new AirtableError("That doesn't look like an Airtable personal access token (it starts with \"pat\").");
  const bases = await listBases(t);
  if (!bases.length) throw new AirtableError("The token works but can't see any bases. In Airtable, give it access to the client's base.");
  const at = await now();
  await db.airtableConnection.upsert({
    where: { id: "default" },
    create: { id: "default", tokenEnc: encrypt(t), lastCheckedAt: at, lastError: "", updatedAt: at },
    update: { tokenEnc: encrypt(t), lastCheckedAt: at, lastError: "", updatedAt: at },
  });
  return bases;
}

export async function bases() {
  return listBases(await token());
}

const cache = new Map<string, { at: number; tables: AirtableTable[] }>();

export async function tables(baseId?: string, fresh = false): Promise<AirtableTable[]> {
  const c = await connection();
  const b = baseId ?? c?.baseId ?? "";
  if (!b) throw new AirtableError("Pick the Airtable base first (Settings → Airtable).");
  const hit = cache.get(b);
  if (!fresh && hit && Date.now() - hit.at < 5 * 60_000) return hit.tables;
  const t = await listTables(await token(), b);
  cache.set(b, { at: Date.now(), tables: t });
  return t;
}

/** The leads table with its fields (fresh from Airtable at most every 5 minutes). */
export async function leadsTable(fresh = false): Promise<AirtableTable> {
  const c = await connection();
  if (!c?.tableId) throw new AirtableError("Pick the leads table first (Settings → Airtable).");
  const t = (await tables(c.baseId, fresh)).find((x) => x.id === c.tableId);
  if (!t) throw new AirtableError(`The leads table "${c.tableName}" isn't in the Airtable base any more. An Admin picks it again in Settings → Airtable.`);
  return t;
}

export async function chooseTable(actor: User, input: { baseId: string; tableId: string; searchFields: string[] }) {
  adminOnly(actor);
  const all = await bases();
  const base = all.find((b) => b.id === input.baseId);
  if (!base) throw new AirtableError("The token can't see that base.");
  const t = (await tables(input.baseId, true)).find((x) => x.id === input.tableId);
  if (!t) throw new AirtableError("That table isn't in the base.");
  const search = input.searchFields.filter((id) => t.fields.some((f) => f.id === id)).slice(0, 5);
  const fieldsToShow = search.length ? search : [t.primaryFieldId];
  await db.airtableConnection.update({
    where: { id: "default" },
    data: { baseId: base.id, baseName: base.name, tableId: t.id, tableName: t.name, searchFields: JSON.stringify(fieldsToShow), lastCheckedAt: await now(), updatedAt: await now() },
  });
}

export async function setWriteBack(actor: User, on: boolean, map: WriteBackMap) {
  adminOnly(actor);
  const t = await leadsTable(true);
  const clean: WriteBackMap = {};
  for (const k of ["status", "sentAt", "signedAt", "link"] as const) if (map[k] && t.fields.some((f) => f.id === map[k])) clean[k] = map[k];
  if (on && !Object.keys(clean).length) throw new AirtableError("Pick at least one Airtable field to write to.");
  await db.airtableConnection.update({ where: { id: "default" }, data: { writeBack: on, writeBackMap: JSON.stringify(clean), updatedAt: await now() } });
}

export async function disconnect(actor: User) {
  adminOnly(actor);
  await db.airtableConnection.deleteMany({ where: { id: "default" } });
  cache.clear();
}

export const searchFieldIds = (c: { searchFields: string }) => {
  try {
    return JSON.parse(c.searchFields || "[]") as string[];
  } catch {
    return [];
  }
};

export type LeadSummary = { id: string; label: string; detail: string };

/** A short label for a record: its search fields' values. */
export function leadLabel(table: AirtableTable, rec: AirtableRecord, ids: string[]): LeadSummary {
  const vals = ids.map((id) => {
    const v = rec.fields[id];
    return Array.isArray(v) ? v.map((x) => (typeof x === "object" && x && "name" in x ? (x as { name: string }).name : String(x))).join(", ") : v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v);
  });
  const primary = rec.fields[table.primaryFieldId];
  const label = vals[0] || (typeof primary === "string" ? primary : "") || rec.id;
  return { id: rec.id, label, detail: vals.slice(1).filter(Boolean).join(" · ") };
}

/** AIR-5: lead search, live. */
export async function findLeads(query: string, max = 20): Promise<LeadSummary[]> {
  const c = await connection();
  if (!c?.tableId) throw new AirtableError("Airtable isn't set up yet. An Admin connects it in Settings → Airtable.");
  const table = await leadsTable();
  const ids = searchFieldIds(c);
  const recs = await searchRecords(await token(), c.baseId, table, ids, query, max);
  await db.airtableConnection.update({ where: { id: "default" }, data: { lastCheckedAt: await now(), lastError: "" } }).catch(() => undefined);
  return recs.map((r) => leadLabel(table, r, ids));
}

export async function lead(recordId: string) {
  const c = await connection();
  if (!c?.tableId) throw new AirtableError("Airtable isn't set up yet.");
  const table = await leadsTable();
  const rec = await getRecord(await token(), c.baseId, c.tableId, recordId);
  return { table, rec, summary: leadLabel(table, rec, searchFieldIds(c)) };
}

export async function noteError(message: string) {
  await db.airtableConnection.update({ where: { id: "default" }, data: { lastError: message.slice(0, 500) } }).catch(() => undefined);
}
