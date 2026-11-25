// OAuth 2.1 for the MCP server (MCP-1), adapted from GR OS: dynamic client registration, PKCE (S256), a consent page
// behind a recent email login (LOG-6), 1-hour access tokens and 30-day refresh tokens rotated on every use. Tokens act as
// that user with their permissions; only SHA-256 hashes are stored. Removing the user, "Sign out everywhere" and
// disconnecting on My account end them. MCP_REDIRECT_HOSTS limits where apps may send people back.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import { db } from "../db";
import { appUrl } from "../email";
import { recentLogin } from "../auth";
import { mcpConfig, OFF_MESSAGE } from "./config";

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86_400;
const CODE_TTL_MS = 5 * 60_000;
export const SCOPE = "agreements";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** MCP_ENABLED=false: registration, consent and tokens all answer "switched off" (503). */
const assertOn = () => {
  if (!mcpConfig().enabled) throw new OAuthError("temporarily_unavailable", OFF_MESSAGE, 503);
};

// ---------- metadata ----------

export const mcpUrl = () => `${appUrl()}/mcp`;

/** RFC 9728: where the MCP endpoint's tokens come from. */
export const protectedResourceMetadata = () => ({
  resource: mcpUrl(),
  authorization_servers: [appUrl()],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "Agreements",
});

/** RFC 8414. */
export const authorizationServerMetadata = () => ({
  issuer: appUrl(),
  authorization_endpoint: `${appUrl()}/oauth/authorize`,
  token_endpoint: `${appUrl()}/api/oauth/token`,
  registration_endpoint: `${appUrl()}/api/oauth/register`,
  revocation_endpoint: `${appUrl()}/api/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [SCOPE],
});

// ---------- clients ----------

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** https to Claude (MCP_REDIRECT_HOSTS: claude.ai and claude.com by default); http only to this machine (Claude Code's local callback). */
export function redirectAllowed(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === "https:") return !u.port && mcpConfig().redirectHosts.includes(u.hostname.toLowerCase());
    return u.protocol === "http:" && LOOPBACK.includes(u.hostname);
  } catch {
    return false;
  }
}

/** The app returns to a program on the person's own computer (Claude Code, MCP Inspector), not to claude.ai. */
export const isLoopback = (uri: string) => {
  try {
    return LOOPBACK.includes(new URL(uri).hostname);
  } catch {
    return false;
  }
};

const redirectRule = () => `Apps can only send you back to ${mcpConfig().redirectHosts.join(" or ")} (https), or to localhost.`;

/** Approving an app needs an email login from the last 10 minutes (LOG-6). */
export const consentNeedsLogin = (s: { authAt: Date } | null | undefined, at = new Date()) => !recentLogin(s, at);

/** RFC 7591 dynamic client registration. */
export async function registerClient(body: unknown) {
  assertOn();
  const b = (body ?? {}) as { client_name?: unknown; redirect_uris?: unknown; token_endpoint_auth_method?: unknown };
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10) throw new OAuthError("invalid_redirect_uri", "Give one to ten redirect_uris.");
  const bad = uris.find((u) => !redirectAllowed(u));
  if (bad) throw new OAuthError("invalid_redirect_uri", `${redirectRule()} Not allowed: ${bad}`);
  if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== "none") throw new OAuthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none, with PKCE) are supported.");
  const name = (typeof b.client_name === "string" ? b.client_name : "MCP client").trim().slice(0, 80) || "MCP client";
  const id = `mcp_${randomUUID()}`;
  const createdAt = new Date();
  await db.oAuthClient.create({ data: { id, name, redirectUris: JSON.stringify(uris), createdAt } });
  return { client_id: id, client_name: name, redirect_uris: uris, client_id_issued_at: Math.floor(createdAt.getTime() / 1000), token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
}

export type AuthorizeParams = { client_id: string; redirect_uri: string; response_type: string; code_challenge: string; code_challenge_method: string; state?: string; scope?: string; resource?: string };

/** Check an authorize request. Errors here are shown on the page (we can't trust the redirect yet). */
export async function checkAuthorize(p: Partial<AuthorizeParams>) {
  assertOn();
  const client = p.client_id ? await db.oAuthClient.findUnique({ where: { id: p.client_id } }) : null;
  if (!client) throw new OAuthError("invalid_client", "This app isn't registered here. Remove the connector and add it again.");
  const uris = JSON.parse(client.redirectUris) as string[];
  if (!p.redirect_uri || !uris.includes(p.redirect_uri)) throw new OAuthError("invalid_request", "The app sent a redirect address it didn't register.");
  // Checked here too, so apps registered before the allowlist (or before MCP_REDIRECT_HOSTS changed) follow it.
  if (!redirectAllowed(p.redirect_uri)) throw new OAuthError("invalid_request", `${redirectRule()} This app asked to return to ${p.redirect_uri}.`);
  if (p.response_type !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
  if (!p.code_challenge || p.code_challenge_method !== "S256") throw new OAuthError("invalid_request", "PKCE with S256 is required.");
  if (p.resource && p.resource.replace(/\/$/, "") !== mcpUrl()) throw new OAuthError("invalid_target", `Tokens here are for ${mcpUrl()} only.`);
  return client;
}

/** The person approved: a one-time code for the client's redirect. */
export async function issueCode(person: Pick<User, "id">, p: AuthorizeParams) {
  await checkAuthorize(p);
  const code = secret("grac");
  await db.oAuthCode.create({ data: { hash: sha(code), clientId: p.client_id, userId: person.id, redirectUri: p.redirect_uri, codeChallenge: p.code_challenge, scope: SCOPE, resource: p.resource ?? "", expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
  const url = new URL(p.redirect_uri);
  url.searchParams.set("code", code);
  if (p.state) url.searchParams.set("state", p.state);
  url.searchParams.set("iss", appUrl());
  return url.toString();
}

export function deniedRedirect(p: AuthorizeParams) {
  const url = new URL(p.redirect_uri);
  url.searchParams.set("error", "access_denied");
  if (p.state) url.searchParams.set("state", p.state);
  return url.toString();
}

// ---------- tokens ----------

async function issueTokens(userId: string, clientId: string, family: string) {
  const [person, client] = await Promise.all([db.user.findUniqueOrThrow({ where: { id: userId } }), db.oAuthClient.findUnique({ where: { id: clientId } })]);
  const access = secret("graa");
  const refresh = secret("grar");
  const t = Date.now();
  const base = { userId, clientId, clientName: client?.name ?? "", sessionEpoch: person.sessionEpoch, family, createdAt: new Date(t) };
  await db.mcpToken.createMany({
    data: [
      { ...base, hash: sha(access), kind: "ACCESS", expiresAt: new Date(t + ACCESS_TTL_S * 1000) },
      { ...base, hash: sha(refresh), kind: "REFRESH", expiresAt: new Date(t + REFRESH_TTL_S * 1000) },
    ],
  });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** The token endpoint (form fields as a plain object). */
export async function token(f: Record<string, string>) {
  assertOn();
  if (f.grant_type === "authorization_code") {
    if (!f.code || !f.code_verifier || !f.client_id) throw new OAuthError("invalid_request", "code, code_verifier and client_id are required.");
    const row = await db.oAuthCode.findUnique({ where: { hash: sha(f.code) } });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) throw new OAuthError("invalid_grant", "The code is invalid, used or expired.");
    // One use only, even if two requests race: the update only matches while usedAt is still null.
    const claimed = await db.oAuthCode.updateMany({ where: { hash: row.hash, usedAt: null }, data: { usedAt: new Date() } });
    if (!claimed.count) throw new OAuthError("invalid_grant", "The code has already been used.");
    if (row.clientId !== f.client_id) throw new OAuthError("invalid_grant", "The code was issued to another client.");
    if (f.redirect_uri && f.redirect_uri !== row.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match.");
    if (s256(f.code_verifier) !== row.codeChallenge) throw new OAuthError("invalid_grant", "PKCE verification failed.");
    if (f.resource && f.resource.replace(/\/$/, "") !== mcpUrl()) throw new OAuthError("invalid_target", `Tokens here are for ${mcpUrl()} only.`);
    const p = await db.user.findUnique({ where: { id: row.userId } });
    if (!p?.active) throw new OAuthError("invalid_grant", "This account isn't active.");
    return issueTokens(row.userId, row.clientId, randomUUID());
  }
  if (f.grant_type === "refresh_token") {
    if (!f.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required.");
    const old = await db.mcpToken.findUnique({ where: { hash: sha(f.refresh_token) } });
    if (!old || old.kind !== "REFRESH" || old.expiresAt.getTime() < Date.now()) throw new OAuthError("invalid_grant", "The refresh token is invalid or expired.");
    if (old.revokedAt) {
      // A rotated refresh token used again: someone may have copied it. End the whole connection.
      await revokeFamily(old.family);
      throw new OAuthError("invalid_grant", "The refresh token was already used. Connect again.");
    }
    if (f.client_id && f.client_id !== old.clientId) throw new OAuthError("invalid_grant", "The token was issued to another client.");
    const p = await db.user.findUnique({ where: { id: old.userId } });
    if (!p?.active || old.sessionEpoch < p.sessionEpoch) throw new OAuthError("invalid_grant", "Sign in again.");
    const claimed = await db.mcpToken.updateMany({ where: { id: old.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!claimed.count) throw new OAuthError("invalid_grant", "The refresh token was already used.");
    return issueTokens(old.userId, old.clientId, old.family);
  }
  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export const revokeFamily = (family: string) => db.mcpToken.updateMany({ where: { family, revokedAt: null }, data: { revokedAt: new Date() } });

/** RFC 7009: revoking either token ends the connection it belongs to. Unknown tokens are fine (200). */
export async function revoke(raw: string) {
  const row = raw ? await db.mcpToken.findUnique({ where: { hash: sha(raw) } }) : null;
  if (row) await revokeFamily(row.family);
}

/** The person behind a bearer token on /mcp and the app it was issued to (for the log), or null. */
export async function accessFor(raw: string): Promise<{ person: User; clientName: string } | null> {
  if (!raw) return null;
  const row = await db.mcpToken.findUnique({ where: { hash: sha(raw) }, include: { user: true } });
  if (!row || row.kind !== "ACCESS" || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
  const p = row.user;
  if (!p.active || row.sessionEpoch < p.sessionEpoch) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 5 * 60_000) await db.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { person: p, clientName: row.clientName || "MCP client" };
}

/** My profile → Connected apps: one row per live connection (a refresh token family). */
export async function connectionsOf(userId: string) {
  const rows = await db.mcpToken.findMany({ where: { userId, kind: "REFRESH", revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
  const families = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!families.has(r.family)) families.set(r.family, r);
  const used = await db.mcpToken.groupBy({ by: ["family"], where: { userId, family: { in: [...families.keys()] } }, _max: { lastUsedAt: true }, _min: { createdAt: true } });
  return [...families.values()].map((r) => {
    const u = used.find((x) => x.family === r.family);
    return { family: r.family, clientName: r.clientName || "MCP client", connectedAt: u?._min.createdAt ?? r.createdAt, lastUsedAt: u?._max.lastUsedAt ?? null };
  });
}

export async function disconnect(userId: string, family: string) {
  await db.mcpToken.updateMany({ where: { userId, family, revokedAt: null }, data: { revokedAt: new Date() } });
}
