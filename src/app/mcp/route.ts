// The MCP endpoint (docs/mcp.md): Streamable HTTP, stateless. OAuth bearer tokens (MCP-1) or personal API keys (MCP-3).
import { accessFor } from "@/lib/mcp/oauth";
import { accessForKey } from "@/lib/mcp/keys";
import { handleMcp } from "@/lib/mcp/server";
import { logRateLimited } from "@/lib/mcp/audit";
import { mcpConfig, OFF_MESSAGE } from "@/lib/mcp/config";
import { json, preflight, unauthorized, withCors } from "@/lib/mcp/http";
import { limited } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const bearer = (req: Request) => {
  const h = req.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
};

/** MCP_ENABLED=false: every request gets this, before any token is looked at. */
const switchedOff = () => json({ jsonrpc: "2.0", error: { code: -32000, message: OFF_MESSAGE }, id: null }, 503, { "Retry-After": "3600" });

export async function POST(req: Request) {
  if (!mcpConfig().enabled) return switchedOff();
  const raw = bearer(req);
  const access = (await accessFor(raw)) ?? (await accessForKey(raw));
  if (!access) return unauthorized();
  const { person, clientName } = access;
  if (limited(`mcp:${person.id}`, 120)) {
    if (!limited(`mcp-limit-logged:${person.id}`, 1)) await logRateLimited(person.id, clientName);
    return json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests: 120 a minute. Wait a moment." }, id: null }, 429, { "Retry-After": "60" });
  }
  return withCors(await handleMcp(req, person, { clientName }));
}

// Stateless server: no server-initiated stream and no sessions to end.
const notAllowed = () => json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. POST JSON-RPC to this endpoint." }, id: null }, 405, { Allow: "POST, OPTIONS" });
export async function GET(req: Request) {
  if (!mcpConfig().enabled) return switchedOff();
  if (!bearer(req)) return unauthorized();
  return notAllowed();
}
export const DELETE = notAllowed;
export const OPTIONS = preflight;
