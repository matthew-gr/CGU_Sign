// OAuth token endpoint: authorization_code (with PKCE) and refresh_token (rotated). Form-encoded, as the spec says;
// JSON is accepted too.
import { OAuthError, token } from "@/lib/mcp/oauth";
import { json, preflight } from "@/lib/mcp/http";
import { clientIp, limited } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

async function fields(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v ?? "")]));
  }
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

export async function POST(req: Request) {
  if (limited(`oauth-token:${clientIp(req.headers)}`, 60)) return json({ error: "too_many_requests", error_description: "Too many requests. Wait a minute." }, 429);
  try {
    return json(await token(await fields(req)));
  } catch (e) {
    if (e instanceof OAuthError) return json({ error: e.code, error_description: e.message }, e.status);
    console.error("oauth token", e);
    return json({ error: "server_error" }, 500);
  }
}
export const OPTIONS = preflight;
