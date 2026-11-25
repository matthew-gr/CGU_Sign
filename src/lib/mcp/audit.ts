// MCP-4: every tool call, read or write, allowed or not, in McpAudit. Who, which app, which tool, the inputs (sensitive-
// looking values masked, long text cut), the outcome and how long it took. Writes keep their result; reads keep only how
// many items came back. Admins read it in Settings → Connector log.
import type { Prisma, User } from "@prisma/client";
import { db } from "../db";
import type { AnyTool } from "./tool";

export type CallStatus = "OK" | "DRY_RUN" | "NEEDS_CONFIRM" | "INVALID" | "REFUSED" | "ERROR" | "RATE_LIMITED";
export const STATUSES: CallStatus[] = ["OK", "DRY_RUN", "NEEDS_CONFIRM", "INVALID", "REFUSED", "ERROR", "RATE_LIMITED"];

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}...` : s);

const SENSITIVE_KEY = /password|secret|token|verifier|\bcode\b|ssn|social|tax|bank|account|card/i;

export function maskInput(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 200)}...` : v;
  if (depth > 3) return "...";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => maskInput(x, depth + 1));
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE_KEY.test(k) ? "***" : maskInput(x, depth + 1)]));
  return String(v);
}

function countOf(out: unknown) {
  if (!out || typeof out !== "object") return null;
  const o = out as Record<string, unknown>;
  const list = Array.isArray(o.items) ? o.items : Object.values(o).find(Array.isArray);
  return list ? (list as unknown[]).length : null;
}

export async function logCall(e: { userId: string; tool: Pick<AnyTool, "name" | "kind">; input: unknown; status: CallStatus; result: unknown; clientName?: string; ms: number }) {
  const ok = e.status === "OK" || e.status === "DRY_RUN";
  const keepResult = e.tool.kind === "write" || !ok;
  await db.mcpAudit
    .create({
      data: {
        userId: e.userId,
        tool: e.tool.name,
        kind: e.tool.kind,
        status: e.status,
        ok,
        input: clip(JSON.stringify(maskInput(e.input ?? {})), 2000),
        result: keepResult ? clip(typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? null)) : "",
        results: e.status === "OK" && e.tool.kind === "read" ? countOf(e.result) : null,
        clientName: (e.clientName ?? "").slice(0, 80),
        ms: Math.round(e.ms),
        at: new Date(),
      },
    })
    .catch((err) => console.error("MCP audit not written", err));
}

export const logRateLimited = (userId: string, clientName: string) =>
  logCall({ userId, tool: { name: "(rate limit)", kind: "read" }, input: {}, status: "RATE_LIMITED", result: "Too many requests: 120 a minute.", clientName, ms: 0 });

export type LogFilter = { userId?: string; tool?: string; outcome?: string };

/** Admins: the latest calls, newest first. */
export async function mcpLog(viewer: Pick<User, "role">, f: LogFilter = {}, take = 200) {
  if (viewer.role !== "ADMIN") throw new Error("Only Admins can see the connector log.");
  const where: Prisma.McpAuditWhereInput = {
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.tool ? { tool: f.tool } : {}),
    ...(f.outcome === "not_ok" ? { ok: false } : f.outcome ? { status: f.outcome } : {}),
  };
  const rows = await db.mcpAudit.findMany({ where, orderBy: [{ at: "desc" }, { id: "asc" }], take: Math.min(take, 500) });
  const names = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  return rows.map((r) => ({ ...r, user: names.get(r.userId) ?? "(removed)" }));
}
