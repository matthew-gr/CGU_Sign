// The signed-in user for pages and server actions. Every page and action calls getActor() (or currentUser()).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@prisma/client";
import { readSession, SESSION_COOKIE } from "./auth";

export type Actor = User;

export const isAdmin = (u: Pick<User, "role">) => u.role === "ADMIN";

/** The user and session, or null when signed out. */
export async function currentSession() {
  return readSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function currentUser(): Promise<User | null> {
  return (await currentSession())?.user ?? null;
}

/** The signed-in user; signed-out visitors go to /login. */
export async function getActor(next?: string): Promise<User> {
  const u = await currentUser();
  if (!u) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  return u;
}

export async function requireAdmin(): Promise<User> {
  const u = await getActor();
  if (!isAdmin(u)) redirect("/");
  return u;
}
