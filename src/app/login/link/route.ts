// LOG-3: the one-click sign-in link from the login email. Works once, only in the browser that asked for the code.
import { NextResponse } from "next/server";
import { AuthError, BROWSER_COOKIE, createSession, SESSION_COOKIE, verifyLoginLink } from "@/lib/auth";
import { appUrl } from "@/lib/email";
import { clientIp } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = u.searchParams.get("id") ?? "";
  const t = u.searchParams.get("t") ?? "";
  const cookie = req.headers.get("cookie") ?? "";
  const nonce = /(?:^|;\s*)as_login=([^;]+)/.exec(cookie)?.[1];
  try {
    const user = await verifyLoginLink(id, t, nonce ? decodeURIComponent(nonce) : undefined);
    const s = await createSession(user, clientIp(req.headers), req.headers.get("user-agent") ?? "");
    const res = NextResponse.redirect(`${appUrl()}/`);
    res.cookies.set(SESSION_COOKIE, s.token, { httpOnly: true, secure: appUrl().startsWith("https://"), sameSite: "lax", path: "/", maxAge: s.maxAge });
    res.cookies.delete(BROWSER_COOKIE);
    return res;
  } catch (e) {
    const msg = e instanceof AuthError ? e.message : "That sign-in link didn't work. Ask for a new code.";
    return NextResponse.redirect(`${appUrl()}/login?error=${encodeURIComponent(msg)}`);
  }
}
