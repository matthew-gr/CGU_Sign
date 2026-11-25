"use server";
// Approving an MCP client (/oauth/authorize), disconnecting one, and personal API keys (My account).
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentSession, getActor } from "../session";
import { now } from "../clock";
import { consentNeedsLogin, deniedRedirect, disconnect, issueCode, OAuthError, type AuthorizeParams } from "./oauth";
import { createKey, revokeKey } from "./keys";

export type Result = { ok?: boolean; error?: string; message?: string; key?: string };

const params = (fd: FormData): AuthorizeParams => ({
  client_id: String(fd.get("client_id") ?? ""),
  redirect_uri: String(fd.get("redirect_uri") ?? ""),
  response_type: String(fd.get("response_type") ?? ""),
  code_challenge: String(fd.get("code_challenge") ?? ""),
  code_challenge_method: String(fd.get("code_challenge_method") ?? ""),
  state: String(fd.get("state") ?? "") || undefined,
  scope: String(fd.get("scope") ?? "") || undefined,
  resource: String(fd.get("resource") ?? "") || undefined,
});

const backTo = (fd: FormData) => `/oauth/authorize?${new URLSearchParams(Object.entries(params(fd)).filter((e): e is [string, string] => !!e[1]))}`;

export async function approveClient(fd: FormData): Promise<Result> {
  const me = await getActor();
  const deny = fd.get("decision") === "deny";
  // LOG-6: approving needs an email login from the last 10 minutes; otherwise log in again and come back here.
  if (!deny && consentNeedsLogin((await currentSession())?.session, await now())) redirect(`/login?${new URLSearchParams({ next: backTo(fd), reauth: "1" })}`);
  let url: string;
  try {
    url = deny ? deniedRedirect(params(fd)) : await issueCode(me, params(fd));
  } catch (e) {
    if (e instanceof OAuthError) return { error: e.message };
    throw e;
  }
  redirect(url);
}

export async function disconnectApp(fd: FormData): Promise<Result> {
  const me = await getActor();
  await disconnect(me.id, String(fd.get("family") ?? ""));
  revalidatePath("/account");
  return { ok: true, message: "Disconnected. That app can't act for you any more." };
}

export async function newApiKey(fd: FormData): Promise<Result> {
  const me = await getActor();
  try {
    const key = await createKey(me, String(fd.get("name") ?? ""));
    revalidatePath("/account");
    return { ok: true, key, message: "Copy this key now. It won't be shown again." };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function revokeApiKey(fd: FormData): Promise<Result> {
  const me = await getActor();
  await revokeKey(me.id, String(fd.get("id") ?? ""));
  revalidatePath("/account");
  return { ok: true, message: "Key revoked." };
}
