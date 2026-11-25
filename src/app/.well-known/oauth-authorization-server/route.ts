import { authorizationServerMetadata } from "@/lib/mcp/oauth";
import { json, preflight } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";
export const GET = () => json(authorizationServerMetadata());
export const OPTIONS = preflight;
