// How a module adds MCP tools (docs/mcp.md, adapted from GR OS). Each module keeps its tools in src/lib/<module>/mcp.ts and exports
// `tools` (an array of defineTool(...)). scripts/gen-mcp-registry.ts finds those files and writes registry.generated.ts,
// so adding a module never means editing a central list. `npm run build` regenerates it.
import { z } from "zod";
import type { User } from "@prisma/client";

export type McpActor = User;

export type ToolDef<I extends z.ZodRawShape, O extends z.ZodRawShape> = {
  /** module_verb_noun, e.g. meetings_create_poll. */
  name: string;
  title: string;
  /** What it does, when to use it, and what it returns: Claude reads this to choose the tool. */
  description: string;
  input: I;
  output: O;
  /** read: changes nothing. write: changes data, and is left out while MCP_WRITE_TOOLS_ENABLED=false. Every call of either kind is logged in McpAudit (src/lib/mcp/audit.ts). */
  kind: "read" | "write";
  /**
   * Writes that change data for other people: return a sentence describing the effect when this call needs
   * `confirm: true` (the server then refuses without it), or null when it doesn't. A `confirm` input is added for you.
   */
  needsConfirm?: (input: z.infer<z.ZodObject<I>>) => string | null;
  /**
   * Writes that can show their effect first: runs every check `run` does and returns what would change, changing
   * nothing. A `dry_run` input is added for you. Build it with `planned` (src/lib/mcp/hr.ts), so the two can't drift.
   */
  preview?: (actor: McpActor, input: z.infer<z.ZodObject<I>>) => Promise<z.infer<z.ZodObject<O>>>;
  /** false: defined so the pattern is visible, but not offered to clients yet. */
  enabled?: boolean;
  /** Runs as the signed-in person: call the module's core functions, which apply the same permissions as the UI. */
  run: (actor: McpActor, input: z.infer<z.ZodObject<I>>) => Promise<z.infer<z.ZodObject<O>>>;
};

/** The registry holds tools of many shapes; inputs are checked against `input` before `needsConfirm` and `run` see them. */
export type AnyTool = Omit<ToolDef<z.ZodRawShape, z.ZodRawShape>, "needsConfirm" | "preview" | "run"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  needsConfirm?: (input: any) => string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preview?: (actor: McpActor, input: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (actor: McpActor, input: any) => Promise<any>;
};

export const defineTool = <I extends z.ZodRawShape, O extends z.ZodRawShape>(t: ToolDef<I, O>) => t;

/** A refusal Claude should read and act on (bad input, not allowed, not found): shown as the tool's error text. */
export class ToolError extends Error {}
