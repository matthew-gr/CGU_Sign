"use server";
// The login form's actions (LOG-1 to LOG-4).
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, BROWSER_COOKIE, createSession, endSession, randomToken, requestLogin, SAME_ANSWER, SESSION_COOKIE, verifyLoginCode } from "./auth";
import { appUrl } from "./email";
import { clientIp } from "./ratelimit";

export type LoginResult = { ok?: boolean; error?: string; message?: string; loginId?: string; href?: string };

const secure = () => appUrl().startsWith("https://");

/** Only same-site paths after login (never an absolute URL from the query string). */
export async function safeNext(next: string | null | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export async function askForCode(email: string): Promise<LoginResult> {
  const h = await headers();
  const jar = await cookies();
  const nonce = randomToken(18);
  try {
    const r = await requestLogin(email, clientIp(h), nonce);
    jar.set(BROWSER_COOKIE, nonce, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: 15 * 60 });
    return { ok: true, message: SAME_ANSWER, loginId: r.loginId };
  } catch (e) {
    if (e instanceof AuthError) return { error: e.message };
    console.error("[login]", e);
    return { error: "Something went wrong. Try again in a minute." };
  }
}

export async function enterCode(loginId: string, code: string, next: string): Promise<LoginResult> {
  const h = await headers();
  try {
    const user = await verifyLoginCode(loginId, code);
    const s = await createSession(user, clientIp(h), h.get("user-agent") ?? "");
    (await cookies()).set(SESSION_COOKIE, s.token, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: s.maxAge });
    return { ok: true, href: await safeNext(next) };
  } catch (e) {
    if (e instanceof AuthError) return { error: e.message };
    console.error("[login]", e);
    return { error: "Something went wrong. Try again in a minute." };
  }
}

export async function logout() {
  const jar = await cookies();
  await endSession(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
