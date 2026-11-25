// Airtable's REST API (AIR-1, AIR-5, AIR-8). A personal access token with data.records:read and schema.bases:read on
// the client's base (plus data.records:write for write-back). Requests go through one queue that keeps under
// Airtable's limit of 5 requests per second per base, and errors come back in plain words.

export type AirtableField = { id: string; name: string; type: string; options?: Record<string, unknown> };
export type AirtableTable = { id: string; name: string; primaryFieldId: string; fields: AirtableField[] };
export type AirtableBase = { id: string; name: string; permissionLevel?: string };
export type AirtableRecord = { id: string; createdTime?: string; fields: Record<string, unknown> };

export class AirtableError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "",
  ) {
    super(message);
  }
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
/** Tests swap in a fake Airtable. */
export function setAirtableFetch(f: Fetcher | null) {
  fetcher = f ?? ((url, init) => fetch(url, init));
}

const API = "https://api.airtable.com/v0";

// ---------- the rate-limit queue: at most 5 requests in any 1-second window ----------

const recent: number[] = [];
let chain: Promise<unknown> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.catch(() => undefined).then(async () => {
    for (;;) {
      const t = Date.now();
      while (recent.length && t - recent[0] >= 1000) recent.shift();
      if (recent.length < 5) break;
      await sleep(1000 - (t - recent[0]) + 5);
    }
    recent.push(Date.now());
    return fn();
  });
  chain = run;
  return run;
}

function explain(status: number, body: { error?: { type?: string; message?: string } | string }): string {
  const type = typeof body.error === "string" ? body.error : (body.error?.type ?? "");
  const msg = typeof body.error === "object" ? (body.error?.message ?? "") : "";
  if (status === 401) return "Airtable rejected the access token. It may have been revoked or mistyped. An Admin can paste a new token in Settings → Airtable.";
  if (status === 403) return `The Airtable token can't do this${type === "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND" ? " (missing scope or access to this base)" : ""}. Check the token has data.records:read and schema.bases:read on the base${msg ? `. Airtable says: ${msg}` : "."}`;
  if (status === 404) return `Airtable couldn't find that base, table or record${msg ? ` (${msg})` : ""}. It may have been deleted or renamed.`;
  if (status === 422) return `Airtable refused the request: ${msg || type || "invalid request"}. A mapped field may have been deleted or changed type.`;
  if (status === 429) return "Airtable is rate limiting us. Wait 30 seconds and try again.";
  if (status >= 500) return "Airtable is having problems right now. Try again in a minute.";
  return `Airtable error ${status}${msg ? `: ${msg}` : ""}`;
}

async function call<T>(token: string, path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  if (!token) throw new AirtableError("Airtable isn't connected yet. An Admin connects it in Settings → Airtable.");
  const res = await queued(() =>
    fetcher(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) }).catch((e) => {
      throw new AirtableError(`Couldn't reach Airtable (${(e as Error).name === "TimeoutError" ? "timed out" : "network error"}). Try again.`);
    }),
  );
  if (res.status === 429 && attempt < 2) {
    await sleep(30_000 / (3 - attempt));
    return call(token, path, init, attempt + 1);
  }
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) throw new AirtableError(explain(res.status, body as { error?: string }), res.status, String((body as { error?: { type?: string } }).error && typeof (body as { error?: unknown }).error === "object" ? (body as { error: { type?: string } }).error.type : ""));
  return body as T;
}

export async function listBases(token: string): Promise<AirtableBase[]> {
  const out: AirtableBase[] = [];
  let offset = "";
  do {
    const r = await call<{ bases: AirtableBase[]; offset?: string }>(token, `/meta/bases${offset ? `?offset=${encodeURIComponent(offset)}` : ""}`);
    out.push(...r.bases);
    offset = r.offset ?? "";
  } while (offset && out.length < 1000);
  return out;
}

export async function listTables(token: string, baseId: string): Promise<AirtableTable[]> {
  const r = await call<{ tables: AirtableTable[] }>(token, `/meta/bases/${encodeURIComponent(baseId)}/tables`);
  return r.tables;
}

export async function getRecord(token: string, baseId: string, tableId: string, recordId: string): Promise<AirtableRecord> {
  return call<AirtableRecord>(token, `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}?returnFieldsByFieldId=true`);
}

const formulaString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const fieldRef = (name: string) => `{${name.replace(/}/g, "\\}")}}`;

/** AIR-5: records where any search field contains the query (case-insensitive), at most `max`. */
export async function searchRecords(token: string, baseId: string, table: AirtableTable, fieldIds: string[], query: string, max = 20): Promise<AirtableRecord[]> {
  const fields = fieldIds.map((id) => table.fields.find((f) => f.id === id)).filter((f): f is AirtableField => !!f);
  const q = query.trim().toLowerCase().slice(0, 100);
  const params = new URLSearchParams({ maxRecords: String(max), pageSize: String(Math.min(max, 100)), returnFieldsByFieldId: "true" });
  if (q && fields.length) params.set("filterByFormula", `OR(${fields.map((f) => `FIND(${formulaString(q)}, LOWER(${fieldRef(f.name)} & ""))`).join(", ")})`);
  for (const f of fields) params.append("fields[]", f.id);
  const r = await call<{ records: AirtableRecord[] }>(token, `/${encodeURIComponent(baseId)}/${encodeURIComponent(table.id)}?${params}`);
  return r.records;
}

export async function updateRecord(token: string, baseId: string, tableId: string, recordId: string, fields: Record<string, unknown>) {
  return call<AirtableRecord>(token, `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}?returnFieldsByFieldId=true`, { method: "PATCH", body: JSON.stringify({ fields, typecast: true }) });
}

/** A record id from "recXXXXXXXXXXXXXX" or an Airtable URL that contains one. */
export function recordIdFrom(input: string): string | null {
  const m = /\b(rec[A-Za-z0-9]{14})\b/.exec(input ?? "");
  return m ? m[1] : null;
}
