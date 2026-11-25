"use server";
// Server actions for agreements (the web app). Grok calls the same core functions through src/lib/agreements/mcp.ts.
import { revalidatePath } from "next/cache";
import { getActor } from "../session";
import type { Result } from "../result";
import { requestCtx } from "../sign/actions";
import { SignError } from "../sign/core";
import { AirtableError } from "../airtable/client";
import { appSettings } from "../settings";
import { endOfDayIn } from "../tz";
import * as A from "./core";

const field = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function run(fn: () => Promise<unknown>, message?: string): Promise<Result> {
  try {
    const out = await fn();
    revalidatePath("/", "layout");
    return { ok: true, message, ...(typeof out === "string" ? { id: out } : {}) };
  } catch (e) {
    if (e instanceof A.AgreementError || e instanceof SignError || e instanceof AirtableError) return { error: e.message };
    console.error("[agreements]", e);
    return { error: "Something went wrong. Try again; if it keeps failing, tell your administrator." };
  }
}

/** AIR-5: live lead search for the New agreement page. */
export async function searchLeadsAction(query: string): Promise<{ items?: { id: string; label: string; detail: string }[]; error?: string }> {
  await getActor();
  try {
    const { findLeads, lead } = await import("../airtable/connection");
    const { recordIdFrom } = await import("../airtable/client");
    const id = recordIdFrom(query);
    if (id) return { items: [(await lead(id)).summary] };
    return { items: await findLeads(query, 20) };
  } catch (e) {
    return { error: e instanceof AirtableError ? e.message : "Couldn't search Airtable." };
  }
}

export async function createAgreementAction(fd: FormData): Promise<Result> {
  const me = await getActor();
  let href = "";
  const r = await run(async () => {
    const a = await A.createAgreement(me, { templateId: field(fd, "templateId"), recordId: field(fd, "recordId") });
    href = `/agreements/${a.id}`;
  });
  return r.ok ? { ...r, href } : r;
}

export async function saveValuesAction(id: string, values: Record<string, unknown>, switches: Record<string, boolean>, parties: A.PartyInput[]): Promise<Result> {
  const me = await getActor();
  return run(() => A.setValues(me, id, values, switches, parties), "Saved.");
}

export async function refreshAction(fd: FormData): Promise<Result> {
  const me = await getActor();
  return run(() => A.refreshFromAirtable(me, field(fd, "id")), "Values read again from Airtable. Your overrides were kept.");
}

export async function sendAction(id: string, o: { message: string; signBy: string; viewers: { name: string; email: string }[]; signingOrder: "SEQUENTIAL" | "PARALLEL" }): Promise<Result> {
  const me = await getActor();
  return run(async () => A.sendAgreement(me, id, { message: o.message, signBy: o.signBy || null, viewers: o.viewers, signingOrder: o.signingOrder }, await requestCtx()), "Sent for signature.");
}

export async function remindAction(fd: FormData): Promise<Result> {
  const me = await getActor();
  return run(async () => {
    const n = await A.remind(me, field(fd, "id"), await requestCtx());
    if (!n) throw new A.AgreementError("Nobody is waiting to sign.");
  }, "Reminder sent with a fresh link.");
}

export async function voidAction(fd: FormData): Promise<Result> {
  const me = await getActor();
  return run(async () => A.voidAgreement(me, field(fd, "id"), field(fd, "reason"), await requestCtx()), "Voided. Signers have been told.");
}

export async function reviseAction(fd: FormData): Promise<Result> {
  const me = await getActor();
  return run(async () => A.revise(me, field(fd, "id"), await requestCtx()), "Back in draft. Signers were told the earlier link no longer works; change what you need and send again.");
}

export async function extendAction(fd: FormData): Promise<Result> {
  const me = await getActor();
  return run(async () => {
    const d = endOfDayIn(field(fd, "until"), (await appSettings()).timeZone);
    if (!d) throw new A.AgreementError("Pick a valid date.");
    await A.extend(me, field(fd, "id"), d, await requestCtx());
  }, "Sign-by date extended.");
}

export async function deleteAction(fd: FormData): Promise<Result> {
  const me = await getActor();
  const r = await run(() => A.deleteAgreement(me, field(fd, "id")), "Deleted.");
  return r.ok ? { ...r, href: "/" } : r;
}

export async function paperAction(fd: FormData): Promise<Result> {
  const me = await getActor();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || !f.size) throw new A.AgreementError("Choose the signed scan.");
    await A.paper(me, field(fd, "id"), { bytes: Buffer.from(await f.arrayBuffer()), mime: f.type, name: f.name }, await requestCtx());
  }, "Marked as signed on paper.");
}
