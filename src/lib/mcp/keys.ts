// MCP-3: personal API keys, the fallback if Grok can't do OAuth with MCP. Created on My account, shown once, sent as
// "Authorization: Bearer ask_...". Same permissions as the user; stored as SHA-256; revocable; last use shown.
import { createHash, randomBytes } from "node:crypto";
import type { User } from "@prisma/client";
import { db } from "../db";
import { mcpConfig } from "./config";

export const KEY_PREFIX = "ask_";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createKey(user: Pick<User, "id">, name: string) {
  if (!mcpConfig().apiKeys) throw new Error("API keys are switched off.");
  const n = name.trim().slice(0, 60) || "API key";
  if ((await db.apiKey.count({ where: { userId: user.id, revokedAt: null } })) >= 5) throw new Error("You already have 5 active keys. Revoke one first.");
  const raw = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  await db.apiKey.create({ data: { userId: user.id, name: n, prefix: raw.slice(0, 10), hash: sha(raw), createdAt: new Date() } });
  return raw;
}

export const keysOf = (userId: string) => db.apiKey.findMany({ where: { userId, revokedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });

export async function revokeKey(userId: string, id: string) {
  await db.apiKey.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** The user behind an API key, or null. */
export async function accessForKey(raw: string): Promise<{ person: User; clientName: string } | null> {
  if (!mcpConfig().apiKeys || !raw.startsWith(KEY_PREFIX)) return null;
  const k = await db.apiKey.findUnique({ where: { hash: sha(raw) } });
  if (!k || k.revokedAt) return null;
  const u = await db.user.findUnique({ where: { id: k.userId } });
  if (!u?.active) return null;
  if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 5 * 60_000) await db.apiKey.update({ where: { id: k.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { person: u, clientName: `API key "${k.name}"` };
}
