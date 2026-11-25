"use server";
// Server actions for Settings: company settings, users, Airtable, templates. Every action re-checks the role.
import { revalidatePath } from "next/cache";
import { getActor } from "./session";
import type { Result } from "./result";
import { appSettings, validTimeZone, writeSettings } from "./settings";
import { inviteUser, removeUser, updateUser, UserError } from "./users";
import { endAllSessions } from "./auth";
import * as AT from "./airtable/connection";
import { AirtableError } from "./airtable/client";
import * as T from "./templates/core";

const field = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function run(fn: () => Promise<unknown>, message: string, path = "/settings"): Promise<Result> {
  try {
    const out = await fn();
    revalidatePath(path, "layout");
    return { ok: true, message, ...(typeof out === "string" ? { id: out } : {}) };
  } catch (e) {
    if (e instanceof UserError || e instanceof AirtableError || e instanceof T.TemplateError) return { error: e.message };
    console.error("[settings]", e);
    return { error: (e as Error).message || "Something went wrong." };
  }
}

const requireAdmin = async () => {
  const me = await getActor();
  if (me.role !== "ADMIN") throw new UserError("Only an Admin can change settings.");
  return me;
};

// ---------- company settings ----------

export async function saveCompanySettings(fd: FormData): Promise<Result> {
  return run(async () => {
    await requireAdmin();
    const s = await appSettings();
    const tz = field(fd, "timeZone");
    if (!validTimeZone(tz)) throw new UserError("That isn't a valid time zone (for example America/New_York).");
    const days = Number(field(fd, "expiryDays"));
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new UserError("The default sign-by must be 1 to 90 days.");
    const years = Number(field(fd, "retentionYears"));
    if (!Number.isInteger(years) || years < 1 || years > 30) throw new UserError("Retention must be 1 to 30 years.");
    const color = field(fd, "brandColor");
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new UserError("The brand colour must look like #1f5f8b.");
    const logo = field(fd, "logoUrl");
    if (logo && !/^https:\/\//.test(logo)) throw new UserError("The logo must be an https:// address.");
    const prefix = field(fd, "referencePrefix").toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(prefix)) throw new UserError("The reference prefix must be 1 to 6 letters.");
    await writeSettings({
      companyName: field(fd, "companyName") || s.companyName,
      productName: field(fd, "productName") || s.productName,
      senderName: field(fd, "senderName") || field(fd, "companyName") || s.senderName,
      replyTo: field(fd, "replyTo"),
      logoUrl: logo,
      brandColor: color || s.brandColor,
      timeZone: tz,
      expiryDays: days,
      dailyReminders: fd.get("dailyReminders") === "on",
      retentionYears: years,
      attachFinalPdf: fd.get("attachFinalPdf") === "on",
      referencePrefix: prefix,
    });
  }, "Settings saved.");
}

/** A new version of the consent text; signers accept the newest from now on. Earlier signatures keep theirs. */
export async function saveConsent(fd: FormData): Promise<Result> {
  return run(async () => {
    await requireAdmin();
    const text = String(fd.get("consentText") ?? "").trim();
    if (text.length < 40) throw new UserError("The consent text is too short.");
    const s = await appSettings();
    const last = s.consent[s.consent.length - 1];
    if (last.text === text) return;
    await writeSettings({ consent: [...s.consent, { version: last.version + 1, text, at: new Date().toISOString() }] });
  }, "Consent text saved as a new version.");
}

// ---------- users ----------

export async function inviteUserAction(fd: FormData): Promise<Result> {
  return run(async () => inviteUser(await getActor(), { email: field(fd, "email"), name: field(fd, "name"), title: field(fd, "title"), role: field(fd, "role") }), "Invited. They'll get an email.", "/settings/users");
}

export async function updateUserAction(fd: FormData): Promise<Result> {
  return run(async () => updateUser(await getActor(), field(fd, "id"), { name: field(fd, "name"), title: field(fd, "title"), role: field(fd, "role") }), "Saved.", "/settings/users");
}

export async function removeUserAction(fd: FormData): Promise<Result> {
  let note = "";
  const r = await run(async () => {
    const out = await removeUser(await getActor(), field(fd, "id"));
    if (out.signatoryFor) note = ` They were the company signatory on ${out.signatoryFor} template version${out.signatoryFor === 1 ? "" : "s"}: pick someone else there.`;
  }, "Removed. Their sessions, connected apps and API keys have ended.", "/settings/users");
  return r.ok ? { ...r, message: r.message + note } : r;
}

export async function signOutEverywhere(): Promise<Result> {
  return run(async () => endAllSessions((await getActor()).id), "Signed out everywhere.", "/account");
}

// ---------- Airtable ----------

export async function saveAirtableToken(fd: FormData): Promise<Result> {
  let n = 0;
  const r = await run(async () => {
    n = (await AT.saveToken(await getActor(), field(fd, "token"))).length;
  }, "Connected.", "/settings/airtable");
  return r.ok ? { ...r, message: `Connected. The token can see ${n} base${n === 1 ? "" : "s"}; pick the base and leads table next.` } : r;
}

export async function chooseAirtableTable(fd: FormData): Promise<Result> {
  return run(async () => AT.chooseTable(await getActor(), { baseId: field(fd, "baseId"), tableId: field(fd, "tableId"), searchFields: fd.getAll("searchFields").map(String) }), "Leads table saved.", "/settings/airtable");
}

export async function saveWriteBack(fd: FormData): Promise<Result> {
  return run(
    async () => AT.setWriteBack(await getActor(), fd.get("writeBack") === "on", { status: field(fd, "status"), sentAt: field(fd, "sentAt"), signedAt: field(fd, "signedAt"), link: field(fd, "link") }),
    "Write-back saved.",
    "/settings/airtable",
  );
}

export async function disconnectAirtable(): Promise<Result> {
  return run(async () => AT.disconnect(await getActor()), "Airtable disconnected.", "/settings/airtable");
}

// ---------- templates ----------

export async function uploadTemplate(fd: FormData): Promise<Result & { href?: string }> {
  let href = "";
  const r = await run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || !f.size) throw new T.TemplateError("Choose a .docx file.");
    const out = await T.uploadVersion(await getActor(), { templateId: field(fd, "templateId") || undefined, name: field(fd, "name"), bytes: Buffer.from(await f.arrayBuffer()), fileName: f.name });
    href = `/templates/${out.version.templateId}?v=${out.version.id}`;
  }, "Uploaded. Describe the fields, then publish.", "/templates");
  return r.ok ? { ...r, href } : r;
}

export async function saveTemplateFields(versionId: string, edits: T.FieldEdit[]): Promise<Result> {
  return run(async () => T.saveFields(await getActor(), versionId, edits), "Fields saved.", "/templates");
}

export async function saveTemplateParties(versionId: string, parties: T.PartyEdit[], order: "SEQUENTIAL" | "PARALLEL"): Promise<Result> {
  return run(async () => T.saveParties(await getActor(), versionId, parties, order), "Signing parties saved.", "/templates");
}

export async function publishVersion(fd: FormData): Promise<Result> {
  return run(async () => T.publish(await getActor(), field(fd, "versionId")), "Published. New agreements use this version.", "/templates");
}

export async function archiveTemplate(fd: FormData): Promise<Result> {
  const archived = field(fd, "archived") === "1";
  return run(async () => T.archive(await getActor(), field(fd, "templateId"), archived), archived ? "Archived. Existing agreements keep working." : "Restored.", "/templates");
}

export async function renameTemplate(fd: FormData): Promise<Result> {
  return run(async () => T.rename(await getActor(), field(fd, "templateId"), field(fd, "name")), "Renamed.", "/templates");
}
