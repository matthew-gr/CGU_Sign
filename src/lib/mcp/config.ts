// The MCP connector's switches (docs/mcp.md). Environment variables, so they can change on Railway without a deploy.
const hosts = (v: string | undefined, d: string) =>
  (v || d)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const mcpConfig = () => ({
  /** "false": /mcp, registration and the token endpoint answer 503. Tokens aren't revoked, so switching back resumes. */
  enabled: process.env.MCP_ENABLED !== "false",
  /** "false": write tools aren't offered. */
  writeTools: process.env.MCP_WRITE_TOOLS_ENABLED !== "false",
  /**
   * MCP-2: the https hosts an app may send people back to after they approve it (exact names). Set to Grok's callback
   * host(s) once confirmed (FRD Q1). http to localhost is always allowed (MCP Inspector, local clients).
   */
  redirectHosts: hosts(process.env.MCP_REDIRECT_HOSTS, "grok.com,x.ai,claude.ai,claude.com"),
  /** "false": personal API keys (MCP-3) are refused. */
  apiKeys: process.env.MCP_API_KEYS !== "false",
});

export const OFF_MESSAGE = "The connector is switched off for now. Ask your administrator.";
