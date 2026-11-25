// Who may do what with an envelope. Every page, action, file route and MCP tool checks these on the server.
//
//   Create        any active user (Admin or Sender).
//   See           its owner, Admins, and staff who are signers on it. External signers and cc viewers never log in;
//                 they use their own links.
//   Manage        (send, remind, extend, revise, void, delete, paper copy, audit trail) the owner and Admins.
import type { User } from "@prisma/client";

export type EnvelopeRef = { ownerId: string };
export type SignerRef = { userId: string | null; email: string };

export const canCreateEnvelopes = (u: Pick<User, "active">) => u.active;

export function envelopeRole(u: Pick<User, "id" | "email" | "role">, e: EnvelopeRef, signers: SignerRef[]): "owner" | "admin" | "signer" | null {
  if (e.ownerId === u.id) return "owner";
  if (u.role === "ADMIN") return "admin";
  if (signers.some((s) => s.userId === u.id || s.email.toLowerCase() === u.email.toLowerCase())) return "signer";
  return null;
}

export const canManage = (u: Pick<User, "id" | "role">, e: EnvelopeRef) => e.ownerId === u.id || u.role === "ADMIN";

export type Viewer = { name: string; email: string };
export const viewersOf = (e: { viewers: string }): Viewer[] => {
  try {
    const v = JSON.parse(e.viewers || "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.email === "string") : [];
  } catch {
    return [];
  }
};
