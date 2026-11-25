// Sign's emails. They carry the document's title and the sender's own message, never contract terms. The final PDF is
// attached unless the envelope is confidential (default: attached, as US signers expect a copy).
import type { SignEnvelope, SignSigner, User } from "@prisma/client";
import { firstName, sendEmail } from "../email";
import { downloadToken, LINK_DAYS_MAX, signingToken } from "./tokens";
import { now } from "../clock";
import { appSettings } from "../settings";
import { dateLong } from "../tz";
import type { Viewer } from "./config";

/** Every signer gets a single-use signed link and confirms with an emailed code. */
export async function signingLink(env: SignEnvelope, s: SignSigner) {
  const t = await now();
  const cap = new Date(t.getTime() + LINK_DAYS_MAX * 86_400_000);
  const exp = env.expiresAt && env.expiresAt < cap ? env.expiresAt : cap;
  return `/s/${signingToken(s.id, s.linkNonce, exp)}`;
}

/** INVITE: the first time; REMIND: again, with a fresh link; AMEND: a revised document replacing one sent before. */
export type InviteKind = "INVITE" | "REMIND" | "AMEND";

export async function invitation(env: SignEnvelope, s: SignSigner, owner: Pick<User, "name" | "email">, kind: InviteKind) {
  const st = await appSettings();
  const link = await signingLink(env, s);
  const due = env.expiresAt ? `\n\nPlease sign by ${dateLong(env.expiresAt, st.timeZone)}.` : "";
  const how = "The link works once: you'll get a 6-digit code by email to confirm it's you. If it stops working, open it again and ask for a new link.";
  const subject = kind === "INVITE" ? `Please sign: ${env.title}` : kind === "AMEND" ? `Updated document: please sign ${env.title}` : `Reminder: please sign ${env.title}`;
  const what = kind === "AMEND" ? `an updated version of "${env.title}" to sign. It replaces the version sent earlier, and any earlier link no longer works.` : `"${env.title}" to sign.`;
  const body = `Hello ${firstName(s.name)},\n\n${owner.name} at ${st.companyName} has sent you ${what}${env.message ? `\n\nMessage from ${firstName(owner.name)}:\n${env.message}` : ""}\n\n${how}${due}`;
  await sendEmail({ to: { email: s.email, name: s.name }, subject, body, link, linkLabel: "Review and sign" });
}

export async function signerRevising(env: SignEnvelope, s: SignSigner) {
  const st = await appSettings();
  const subject = `Being updated: ${env.title}`;
  const body = `Hello ${firstName(s.name)},\n\n${st.companyName} is making changes to "${env.title}" before it's signed, so the link you were sent no longer works.\n\nYou'll get a new email with a link to the updated document when it's ready.`;
  await sendEmail({ to: { email: s.email, name: s.name }, subject, body });
}

export async function code(env: SignEnvelope, s: SignSigner, c: string) {
  const st = await appSettings();
  const subject = `Your ${st.companyName} signing code: ${c}`;
  const body = `Your code to confirm it's you is ${c}.\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.`;
  await sendEmail({ to: { email: s.email, name: s.name }, subject, body });
}

type OwnerEvent = "SIGNED" | "DECLINED" | "VOIDED" | "EXPIRED";

export async function ownerNotice(env: SignEnvelope, owner: Pick<User, "name" | "email">, kind: OwnerEvent, by: string, link: string) {
  const subject =
    kind === "SIGNED" ? `${by} signed: ${env.title}` : kind === "DECLINED" ? `Declined: ${env.title}` : kind === "VOIDED" ? `Voided: ${env.title}` : `Expired: ${env.title}`;
  const body =
    kind === "SIGNED"
      ? `${by} has signed "${env.title}". It's still waiting for other signers.`
      : kind === "DECLINED"
        ? `${by} declined to sign "${env.title}", so signing has stopped.\n\nTheir reason: ${env.reason}`
        : kind === "VOIDED"
          ? `"${env.title}" was voided${by ? ` by ${by}` : ""}.\n\nReason: ${env.reason}`
          : `"${env.title}" expired before everyone signed. Signing has stopped; send it again if it's still needed.`;
  await sendEmail({ to: { email: owner.email, name: owner.name }, subject, body, link, linkLabel: "Open" });
}

export async function signerStopped(env: SignEnvelope, s: Pick<SignSigner, "email" | "name">, kind: "DECLINED" | "VOIDED" | "EXPIRED") {
  const st = await appSettings();
  const subject = `No longer needed: ${env.title}`;
  const body =
    kind === "VOIDED"
      ? `${st.companyName} cancelled the signing request for "${env.title}". You don't need to do anything.${env.reason ? `\n\nReason: ${env.reason}` : ""}`
      : kind === "DECLINED"
        ? `Signing of "${env.title}" has stopped because another signer declined. You don't need to do anything.`
        : `The signing request for "${env.title}" has expired. You don't need to do anything; the sender will be in touch if it's still needed.`;
  await sendEmail({ to: { email: s.email, name: s.name }, subject, body });
}

/**
 * Everyone (signers, cc viewers, the owner) gets the completion email. Signers and viewers get a download link that
 * asks for a fresh code and lasts 30 days; the PDF is attached unless the envelope is confidential.
 */
export async function completed(env: SignEnvelope, signers: SignSigner[], viewers: { viewer: Viewer; token: string }[], owner: Pick<User, "name" | "email">, pdf: Buffer, ownerLink: string) {
  const st = await appSettings();
  const t = await now();
  const attachOk = st.attachFinalPdf && !env.confidential && pdf.length < 15 * 1024 * 1024;
  const attach = attachOk ? [{ filename: `${env.title.replace(/[^\w .()-]/g, "_").slice(0, 80)} (signed).pdf`, type: "application/pdf", content: pdf.toString("base64"), encoding: "base64" as const }] : undefined;
  const note = attach ? "The signed PDF is attached, with its certificate of completion on the last page." : "Download the signed PDF with the link below.";
  const subject = `Completed: ${env.title}`;
  for (const s of signers) {
    const body = `Hello ${firstName(s.name)},\n\nEveryone has signed "${env.title}".\n\n${note}\n\nThe download link asks for a 6-digit code sent to this address and works for 30 days. Keep a copy for your records.`;
    await sendEmail({ to: { email: s.email, name: s.name }, subject, body, link: `/d/${downloadToken(s.id, t)}`, linkLabel: "Download the signed PDF", attachments: attach });
  }
  for (const { viewer, token } of viewers) {
    const body = `Hello ${firstName(viewer.name || viewer.email)},\n\nEveryone has signed "${env.title}", and you were copied on it.\n\n${note}\n\nThe download link asks for a 6-digit code sent to this address and works for 30 days.`;
    await sendEmail({ to: { email: viewer.email, name: viewer.name }, subject, body, link: `/d/${token}`, linkLabel: "Download the signed PDF", attachments: attach });
  }
  const told = new Set([...signers.map((s) => s.email.toLowerCase()), ...viewers.map((v) => v.viewer.email.toLowerCase())]);
  if (!told.has(owner.email.toLowerCase()))
    await sendEmail({ to: { email: owner.email, name: owner.name }, subject, body: `Everyone has signed "${env.title}". ${note}`, link: ownerLink, linkLabel: "Open", attachments: attach });
}
