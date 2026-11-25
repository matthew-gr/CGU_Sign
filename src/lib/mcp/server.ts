// The GR OS MCP server (docs/mcp.md): stateless Streamable HTTP, one server per request, built for the person whose
// token came with it. Tools come from every module's mcp.ts (registry.generated.ts); this file adds the shared rules:
// the write-tools switch, the confirm gate for writes that affect other people, the call log, and error handling.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ToolError, type AnyTool, type McpActor } from "./tool";
import { moduleTools } from "./registry.generated";
import { logCall, type CallStatus } from "./audit";
import { mcpConfig } from "./config";
import { appUrl } from "../email";
import { SignError } from "../sign/core";
import { AgreementError } from "../agreements/core";
import { TemplateError } from "../templates/core";
import { AirtableError } from "../airtable/client";

/** Refusals and plain-words errors the user should read (anything else is logged and reported generically). */
const isKnownError = (e: unknown) => e instanceof ToolError || e instanceof SignError || e instanceof AgreementError || e instanceof TemplateError || e instanceof AirtableError;

/** The tools offered now: enabled ones, without writes while MCP_WRITE_TOOLS_ENABLED=false. */
export const enabledTools = (): AnyTool[] => {
  const writes = mcpConfig().writeTools;
  return moduleTools.filter((t) => t.enabled !== false && (writes || t.kind === "read"));
};

/** Which app made the call (from its token), for the log. */
export type CallContext = { clientName?: string };

/** Run one tool as `actor`, with the confirm gate; every call, whatever the outcome, goes in the log. Exported for tests. */
export async function callTool(actor: McpActor, tool: AnyTool, rawInput: Record<string, unknown>, ctx: CallContext = {}) {
  const started = Date.now();
  const log = (status: CallStatus, result: unknown) => logCall({ userId: actor.id, tool, input: rawInput, status, result, clientName: ctx.clientName, ms: Date.now() - started });
  const { confirm: gateConfirm, dry_run, ...rest } = rawInput;
  // A tool that declares its own `confirm` input (send_agreement shows a summary first) gets it; others use the gate.
  const input = "confirm" in tool.input ? { ...rest, ...(gateConfirm !== undefined ? { confirm: gateConfirm } : {}) } : rest;
  const confirm = gateConfirm;
  const parsed = z.object(tool.input).safeParse(input);
  if (!parsed.success) {
    const error = `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
    await log("INVALID", error);
    return { ok: false as const, error };
  }
  const dryRun = dry_run === true;
  // Never fall through to the real thing when a dry run was asked for.
  if (dryRun && !tool.preview) {
    const error = `${tool.name} has no dry run. Nothing was changed.`;
    await log("INVALID", error);
    return { ok: false as const, error };
  }
  const effect = dryRun ? null : (tool.needsConfirm?.(parsed.data) ?? null);
  if (effect && confirm !== true) {
    const msg = `Not done yet. ${effect} Ask the user to confirm, then call ${tool.name} again with confirm: true.`;
    await log("NEEDS_CONFIRM", msg);
    return { ok: false as const, error: msg };
  }
  try {
    const out = dryRun ? await tool.preview!(actor, parsed.data) : await tool.run(actor, parsed.data);
    await log(dryRun ? "DRY_RUN" : "OK", out);
    return { ok: true as const, out };
  } catch (e) {
    const known = isKnownError(e);
    if (!known) console.error(`MCP ${tool.name}`, e);
    const error = known ? (e as Error).message : "Something went wrong. Try again; if it keeps failing, tell your administrator.";
    await log(known ? "REFUSED" : "ERROR", error);
    return { ok: false as const, error };
  }
}

export function buildServer(actor: McpActor, ctx: CallContext = {}) {
  const server = new McpServer(
    { name: "agreement-signer", title: "Agreements", version: "1.0.0" },
    { instructions: `This connector prepares and sends service agreements for e-signature, filled from the company's Airtable leads. You are acting as ${actor.name} (${actor.email}) with their permissions. You never write or edit contract wording: you can only fill the named fields and yes/no optional sections a template defines. Typical flow: find_leads, then prepare_agreement (it returns "missing": ask the user for exactly those values), then set_values, then send_agreement without confirm (it returns a summary: show it to the user), then send_agreement with confirm: true once they agree. Money is in US dollars; dates are YYYY-MM-DD.` },
  );
  for (const tool of enabledTools()) {
    const input = {
      ...tool.input,
      ...(tool.needsConfirm ? { confirm: z.boolean().optional().describe("Set to true only after the user has agreed to the effect described in the first reply.") } : {}),
      ...(tool.preview ? { dry_run: z.boolean().optional().describe("true: run every check and return what would change, without changing anything or telling anyone.") } : {}),
    };
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: input, outputSchema: tool.output, annotations: { readOnlyHint: tool.kind === "read", destructiveHint: tool.kind === "write" && !!tool.needsConfirm, openWorldHint: false } },
      async (args: Record<string, unknown>) => {
        const r = await callTool(actor, tool, args, ctx);
        if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: r.error }] };
        return { structuredContent: r.out as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(r.out, null, 2) }] };
      },
    );
  }
  return server;
}

/** Handle one HTTP request to /mcp for an authenticated person. */
export async function handleMcp(req: Request, actor: McpActor, ctx: CallContext = {}) {
  const server = buildServer(actor, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // JSON responses are complete once handleRequest returns.
    await server.close().catch(() => undefined);
  }
}
