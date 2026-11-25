// Shared HTTP bits for the MCP endpoint and its OAuth routes. They're called by Claude's servers and by local tools
// (bearer tokens, never cookies), so permissive CORS is safe and lets browser-based MCP clients connect.
import { appUrl } from "../email";

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", ...headers } });

export const withCors = (res: Response) => {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};

/** 401 that tells the client where to start OAuth (RFC 9728). */
export const unauthorized = (description = "Sign in to use this connector.") =>
  json({ error: "invalid_token", error_description: description }, 401, {
    "WWW-Authenticate": `Bearer realm="Agreements", error="invalid_token", error_description="${description}", resource_metadata="${appUrl()}/.well-known/oauth-protected-resource/mcp"`,
  });
