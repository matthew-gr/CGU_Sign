import { protectedResourceMetadata } from "@/lib/mcp/oauth";
import { json, preflight } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";
export const GET = () => json(protectedResourceMetadata());
export const OPTIONS = preflight;
