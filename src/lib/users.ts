// LOG-5: Admins invite users by email and set their role. Removing a user ends their sessions, MCP tokens and API keys.
import type { User } from "@prisma/client";
import { db } from "./db";
import { endAllSessions } from "./auth";
import { sendEmail } from "./email";
import { appSettings } from "./settings";

export class UserError extends Error {}
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const admin = (u: Pick<User, "role">) => {
  if (u.role !== "ADMIN") throw new UserError("Only an Admin can manage users.");
};

export async function inviteUser(actor: User, input: { email: string; name: string; title?: string; role: string }) {
  admin(actor);
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new UserError("Enter a valid email address.");
  if (!input.name.trim()) throw new UserError("Enter their name.");
  const role = input.role === "ADMIN" ? "ADMIN" : "SENDER";
  const existing = await db.user.findUnique({ where: { email } });
  if (existing?.active) throw new UserError("That person already has an account.");
  const user = existing
    ? await db.user.update({ where: { id: existing.id }, data: { active: true, name: input.name.trim(), title: (input.title ?? "").trim(), role } })
    : await db.user.create({ data: { email, name: input.name.trim().slice(0, 120), title: (input.title ?? "").trim().slice(0, 120), role } });
  const s = await appSettings();
  await sendEmail({
    to: { email, name: user.name },
    subject: `You've been invited to ${s.companyName} ${s.productName}`,
    body: `${actor.name} has given you access to ${s.companyName}'s agreements app as ${role === "ADMIN" ? "an Admin" : "a Sender"}.\n\nTo sign in, open the link and enter this email address. We'll email you a 6-digit code; there's no password.`,
    link: "/login",
    linkLabel: "Sign in",
  });
  return user;
}

export async function updateUser(actor: User, id: string, input: { name?: string; title?: string; role?: string }) {
  admin(actor);
  const u = await db.user.findUnique({ where: { id } });
  if (!u) throw new UserError("User not found.");
  const role = input.role === undefined ? u.role : input.role === "ADMIN" ? "ADMIN" : "SENDER";
  if (u.role === "ADMIN" && role !== "ADMIN" && (await db.user.count({ where: { role: "ADMIN", active: true } })) <= 1) throw new UserError("There must always be at least one Admin.");
  return db.user.update({ where: { id }, data: { ...(input.name?.trim() ? { name: input.name.trim().slice(0, 120) } : {}), ...(input.title !== undefined ? { title: input.title.trim().slice(0, 120) } : {}), role } });
}

export async function removeUser(actor: User, id: string) {
  admin(actor);
  const u = await db.user.findUnique({ where: { id } });
  if (!u || !u.active) throw new UserError("User not found.");
  if (u.id === actor.id) throw new UserError("You can't remove yourself. Ask another Admin.");
  if (u.role === "ADMIN" && (await db.user.count({ where: { role: "ADMIN", active: true } })) <= 1) throw new UserError("There must always be at least one Admin.");
  const signatoryFor = await db.templateParty.count({ where: { userId: id } });
  await db.user.update({ where: { id }, data: { active: false } });
  await endAllSessions(id);
  await db.apiKey.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  return { signatoryFor };
}

export const listUsers = () => db.user.findMany({ where: { active: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
