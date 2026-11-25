// Staff login by emailed code (FRD §5). No passwords. Server-only (node:crypto, database).
//
//   LOG-1  Ask for a code: an active user gets a 6-digit code; anyone else gets the same answer and nothing is sent.
//   LOG-2  10 minutes; 5 wrong tries lock it for 15 minutes; 3 codes per 10 minutes and 10 a day per address; 20 per
//          10 minutes per IP. Only HMACs of codes are stored.
//   LOG-3  The email also has a one-click link: works once, and only in the browser that asked (a nonce cookie).
//   LOG-4  Session: random token in an HTTP-only cookie, hashed in Session. Sliding 14 days, hard cap 30 days.
//          "Sign out everywhere" raises the user's sessionEpoch.
//   LOG-6  Approving an MCP app needs a login from the last 10 minutes.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { now } from "./clock";
import { sendEmail } from "./email";
import { appSettings } from "./settings";

export const SESSION_COOKIE = "as_session";
export const BROWSER_COOKIE = "as_login"; // nonce for the one-click link
export const CODE_MINUTES = 10;
export const CODE_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const CODES_PER_10_MIN = 3;
export const CODES_PER_DAY = 10;
export const IP_PER_10_MIN = 20;
export const SLIDE_DAYS = 14;
export const ABSOLUTE_DAYS = 30;
export const RECENT_LOGIN_MS = 10 * 60_000;
const DAY = 86_400_000;

export class AuthError extends Error {}

export function authSecret() {
  const s = process.env.AUTH_SECRET || "";
  if (s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET (32+ characters) must be set.");
  return "local-development-auth-secret-0123456789";
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (purpose: string, data: string) => createHmac("sha256", authSecret()).update(`${purpose}:${data}`).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const randomToken = (n = 32) => randomBytes(n).toString("base64url");
const normEmail = (e: string) => (e ?? "").trim().toLowerCase();
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export const SAME_ANSWER = "If you have an account, we've sent a 6-digit code to that address. It works for 10 minutes.";

/**
 * LOG-1/2/3. Returns the login id (for the code form) and, for tests only, the code and link token. `browserNonce` is the
 * value the caller sets in BROWSER_COOKIE.
 */
export async function requestLogin(rawEmail: string, ip: string, browserNonce: string) {
  const email = normEmail(rawEmail);
  if (!EMAIL.test(email)) throw new AuthError("Enter a valid email address.");
  const t = await now();
  const since10 = new Date(t.getTime() - 10 * 60_000);
  const since24 = new Date(t.getTime() - DAY);
  if ((await db.loginCode.count({ where: { ip, createdAt: { gt: since10 } } })) >= IP_PER_10_MIN) throw new AuthError("Too many attempts from this network. Wait 10 minutes and try again.");
  if ((await db.loginCode.count({ where: { email, createdAt: { gt: since10 } } })) >= CODES_PER_10_MIN) throw new AuthError("Too many codes requested. Wait 10 minutes and try again.");
  if ((await db.loginCode.count({ where: { email, createdAt: { gt: since24 } } })) >= CODES_PER_DAY) throw new AuthError("Too many codes requested today. Try again tomorrow.");
  const user = await db.user.findFirst({ where: { email, active: true } });
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const link = randomToken(24);
  const row = await db.loginCode.create({
    data: {
      email,
      userId: user?.id ?? null,
      codeHash: user ? hmac("login-code", `${email}:${code}`) : "",
      linkHash: user ? sha(link) : "",
      browserHash: sha(browserNonce),
      expiresAt: new Date(t.getTime() + CODE_MINUTES * 60_000),
      ip: ip.slice(0, 64),
      createdAt: t,
    },
  });
  if (user) {
    const s = await appSettings();
    await sendEmail({
      to: { email, name: user.name },
      subject: `Your ${s.productName} sign-in code: ${code}`,
      body: `Your sign-in code is ${code}. It works for ${CODE_MINUTES} minutes.\n\nOr use the button below, in the same browser where you asked for the code.\n\nIf you didn't ask for this, ignore this email.`,
      link: `/login/link?id=${row.id}&t=${link}`,
      linkLabel: "Sign in",
    });
  }
  return { loginId: row.id, code: user ? code : null, link: user ? link : null };
}

async function finish(row: { id: string; userId: string | null }, t: Date) {
  await db.loginCode.update({ where: { id: row.id }, data: { usedAt: t, codeHash: "", linkHash: "" } });
  const user = await db.user.findUnique({ where: { id: row.userId! } });
  if (!user?.active) throw new AuthError("This account isn't active.");
  return user;
}

/** LOG-2: check a typed code. */
export async function verifyLoginCode(loginId: string, code: string) {
  const t = await now();
  const row = await db.loginCode.findUnique({ where: { id: loginId } });
  const generic = "That code isn't right, or it has expired. Ask for a new one.";
  if (!row || row.usedAt) throw new AuthError(generic);
  if (row.lockedUntil && row.lockedUntil > t) throw new AuthError(`Too many wrong codes. Try again in ${Math.ceil((row.lockedUntil.getTime() - t.getTime()) / 60_000)} minutes.`);
  if (row.expiresAt <= t) throw new AuthError("That code has expired. Ask for a new one.");
  const ok = !!row.userId && !!row.codeHash && same(row.codeHash, hmac("login-code", `${row.email}:${(code ?? "").replace(/\D/g, "")}`));
  if (!ok) {
    const attempts = row.attempts + 1;
    if (attempts >= CODE_ATTEMPTS) {
      await db.loginCode.update({ where: { id: row.id }, data: { attempts: 0, lockedUntil: new Date(t.getTime() + LOCK_MINUTES * 60_000) } });
      throw new AuthError(`Too many wrong codes. Locked for ${LOCK_MINUTES} minutes.`);
    }
    await db.loginCode.update({ where: { id: row.id }, data: { attempts } });
    throw new AuthError(`That code isn't right. ${CODE_ATTEMPTS - attempts} ${CODE_ATTEMPTS - attempts === 1 ? "try" : "tries"} left.`);
  }
  return finish(row, t);
}

/** LOG-3: the emailed one-click link, in the same browser only. */
export async function verifyLoginLink(loginId: string, token: string, browserNonce: string | undefined) {
  const t = await now();
  const row = await db.loginCode.findUnique({ where: { id: loginId } });
  if (!row || row.usedAt || !row.linkHash || row.expiresAt <= t || (row.lockedUntil && row.lockedUntil > t)) throw new AuthError("This sign-in link has expired or was already used. Ask for a new code.");
  if (!same(row.linkHash, sha(token ?? ""))) throw new AuthError("This sign-in link isn't valid. Ask for a new code.");
  if (!browserNonce || !same(row.browserHash, sha(browserNonce))) throw new AuthError("Open the link in the same browser where you asked for the code, or type the 6-digit code instead.");
  return finish(row, t);
}

// ---------- sessions ----------

export async function createSession(user: { id: string; sessionEpoch: number }, ip = "", ua = "") {
  const t = await now();
  const token = randomToken();
  await db.session.create({
    data: {
      tokenHash: sha(token),
      userId: user.id,
      epoch: user.sessionEpoch,
      authAt: t,
      expiresAt: new Date(t.getTime() + SLIDE_DAYS * DAY),
      absoluteAt: new Date(t.getTime() + ABSOLUTE_DAYS * DAY),
      lastSeenAt: t,
      ip: ip.slice(0, 64),
      userAgent: ua.slice(0, 300),
    },
  });
  return { token, maxAge: SLIDE_DAYS * 86_400 };
}

/** The session and user for a cookie value, sliding the expiry (at most once an hour). Null if not valid. */
export async function readSession(token: string | undefined) {
  if (!token) return null;
  const t = await now();
  const s = await db.session.findUnique({ where: { tokenHash: sha(token) } });
  if (!s || s.expiresAt <= t || s.absoluteAt <= t) return null;
  const user = await db.user.findUnique({ where: { id: s.userId } });
  if (!user?.active || s.epoch < user.sessionEpoch) return null;
  if (t.getTime() - s.lastSeenAt.getTime() > 3_600_000) {
    const expiresAt = new Date(Math.min(t.getTime() + SLIDE_DAYS * DAY, s.absoluteAt.getTime()));
    await db.session.update({ where: { id: s.id }, data: { lastSeenAt: t, expiresAt } }).catch(() => undefined);
  }
  return { session: s, user };
}

export async function endSession(token: string | undefined) {
  if (token) await db.session.deleteMany({ where: { tokenHash: sha(token) } });
}

/** "Sign out everywhere", and removing a user (LOG-5): every session and MCP token ends at once. */
export async function endAllSessions(userId: string) {
  await db.user.update({ where: { id: userId }, data: { sessionEpoch: { increment: 1 } } });
  await db.session.deleteMany({ where: { userId } });
  await db.mcpToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export const recentLogin = (s: { authAt: Date } | null | undefined, at: Date) => !!s && at.getTime() - s.authAt.getTime() <= RECENT_LOGIN_MS;
