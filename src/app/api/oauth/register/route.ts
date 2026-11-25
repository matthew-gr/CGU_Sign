// RFC 7591 dynamic client registration for MCP clients (Claude). Public clients with PKCE only; rate-limited per IP.
import { OAuthError, registerClient } from "@/lib/mcp/oauth";
import { json, preflight } from "@/lib/mcp/http";
import { clientIp, limited } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (limited(`oauth-register:${clientIp(req.headers)}`, 10, 60 * 60_000)) return json({ error: "too_many_requests", error_description: "Too many registrations from here. Try again in an hour." }, 429);
  try {
    return json(await registerClient(await req.json().catch(() => null)), 201);
  } catch (e) {
    if (e instanceof OAuthError) return json({ error: e.code, error_description: e.message }, e.status);
    console.error("oauth register", e);
    return json({ error: "server_error" }, 500);
  }
}
export const OPTIONS = preflight;
