// RFC 7009 token revocation: ends the whole connection the token belongs to. Always 200.
import { revoke } from "@/lib/mcp/oauth";
import { json, preflight } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const f = new URLSearchParams(await req.text());
  await revoke(f.get("token") ?? "").catch((e) => console.error("oauth revoke", e));
  return json({});
}
export const OPTIONS = preflight;
