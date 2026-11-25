// Templates and their versions (FRD §6). Admins upload the client's .docx; each upload is a new version with its own
// field definitions, parties and SHA-256. An agreement always records the version it was made from.
import { createHash } from "node:crypto";
import type { Template, TemplateField, TemplateParty, TemplateVersion, User } from "@prisma/client";
import { db } from "../db";
import { now } from "../clock";
import { readBytes, saveBytes } from "../file/storage";
import { fillTemplate, scanTemplate, type Scan } from "./engine";
import { FIELD_TYPES, FORMATTERS_FOR, guessType, labelFor, type FieldType, type Value } from "./format";
import { toPdf } from "./pdf";

export class TemplateError extends Error {}
const fail = (m: string): never => {
  throw new TemplateError(m);
};

const MAX_DOCX = 10 * 1024 * 1024;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const admin = (u: Pick<User, "role">) => {
  if (u.role !== "ADMIN") fail("Only an Admin can change templates.");
};

export const scanOf = (v: Pick<TemplateVersion, "scan">) => JSON.parse(v.scan) as Scan;

export type VersionFull = TemplateVersion & { template: Template; fields: TemplateField[]; parties: TemplateParty[] };

export async function versionFull(versionId: string): Promise<VersionFull> {
  const v = await db.templateVersion.findUnique({ where: { id: versionId } });
  if (!v) fail("Template version not found.");
  const [template, fields, parties] = await Promise.all([
    db.template.findUniqueOrThrow({ where: { id: v!.templateId } }),
    db.templateField.findMany({ where: { versionId }, orderBy: [{ position: "asc" }, { tag: "asc" }] }),
    db.templateParty.findMany({ where: { versionId }, orderBy: { signer: "asc" } }),
  ]);
  return { ...v!, template, fields, parties };
}

/** The newest published version of a template (what new agreements use). */
export async function publishedVersion(templateId: string) {
  return db.templateVersion.findFirst({ where: { templateId, published: true }, orderBy: { version: "desc" } });
}

/** TPL-1/TPL-5: upload a .docx as a new template, or as the next version of one. Field definitions carry over by tag. */
export async function uploadVersion(actor: User, input: { templateId?: string; name?: string; bytes: Buffer; fileName: string }) {
  admin(actor);
  if (!/\.docx$/i.test(input.fileName)) fail("Upload a Word document (.docx).");
  if (input.bytes.length > MAX_DOCX) fail("The file is over 10 MB.");
  let scan: Scan;
  try {
    scan = scanTemplate(input.bytes);
  } catch (e) {
    return fail((e as Error).message);
  }
  const t = await now();
  let template: Template;
  if (input.templateId) {
    template = (await db.template.findUnique({ where: { id: input.templateId } })) ?? fail("Template not found.");
  } else {
    const name = (input.name ?? "").trim() || input.fileName.replace(/\.docx$/i, "");
    template = await db.template.create({ data: { name: name.slice(0, 120), createdAt: t } });
  }
  const prev = await db.templateVersion.findFirst({ where: { templateId: template.id }, orderBy: { version: "desc" } });
  const prevFields = prev ? await db.templateField.findMany({ where: { versionId: prev.id } }) : [];
  const prevParties = prev ? await db.templateParty.findMany({ where: { versionId: prev.id } }) : [];
  const key = await saveBytes(input.bytes);
  const v = await db.templateVersion.create({
    data: {
      templateId: template.id,
      version: (prev?.version ?? 0) + 1,
      fileName: input.fileName.replace(/[^\w .()-]/g, "_").slice(0, 120),
      storageKey: key,
      sha256: sha(input.bytes),
      scan: JSON.stringify(scan),
      signingOrder: prev?.signingOrder ?? "SEQUENTIAL",
      createdById: actor.id,
      createdAt: t,
    },
  });
  const tags = [...scan.fields.map((f) => ({ tag: f.tag, isSwitch: false, f })), ...scan.sections.map((s) => ({ tag: s, isSwitch: true, f: null }))];
  for (const [i, x] of tags.entries()) {
    const old = prevFields.find((p) => p.tag === x.tag && p.isSwitch === x.isSwitch);
    const type: FieldType = x.isSwitch ? "BOOLEAN" : ((old?.type as FieldType) ?? guessType(x.tag, x.f?.formatters ?? []));
    await db.templateField.create({
      data: {
        versionId: v.id,
        tag: x.tag,
        isSwitch: x.isSwitch,
        position: i,
        label: old?.label ?? (x.isSwitch ? `Include ${labelFor(x.tag).replace(/^Include /i, "").toLowerCase()}` : labelFor(x.tag)),
        type,
        required: old?.required ?? !x.isSwitch,
        help: old?.help ?? "",
        defaultVal: old?.defaultVal ?? (x.isSwitch ? "false" : ""),
        min: old?.min ?? null,
        max: old?.max ?? null,
        locked: old?.locked ?? false,
        source: old?.source ?? "ASK",
        airtableId: old?.airtableId ?? "",
      },
    });
  }
  for (const n of scan.signers) {
    const old = prevParties.find((p) => p.signer === n);
    await db.templateParty.create({
      data: {
        versionId: v.id,
        signer: n,
        role: old?.role ?? (n === 1 ? "Client" : n === 2 ? "Company" : `Party ${n}`),
        source: old?.source ?? (n === 1 ? "LEAD" : n === 2 ? "SIGNATORY" : "TYPED"),
        nameField: old?.nameField ?? "",
        emailField: old?.emailField ?? "",
        companyField: old?.companyField ?? "",
        userId: old?.userId ?? null,
      },
    });
  }
  return { version: v, scan, carried: prevFields.length > 0 };
}

export type FieldEdit = {
  tag: string;
  label: string;
  type: FieldType;
  required: boolean;
  help?: string;
  defaultVal?: string;
  min?: number | null;
  max?: number | null;
  locked?: boolean;
  source: "AIRTABLE" | "FIXED" | "ASK";
  airtableId?: string;
};

/** TPL-3 / AIR-3: describe each field and where its value comes from. */
export async function saveFields(actor: User, versionId: string, edits: FieldEdit[]) {
  admin(actor);
  const v = await versionFull(versionId);
  const scan = scanOf(v);
  for (const e of edits) {
    const f = v.fields.find((x) => x.tag === e.tag);
    if (!f) fail(`"${e.tag}" isn't a field in this version.`);
    const label = (e.label ?? "").trim();
    if (!label) fail(`Give "${e.tag}" a label.`);
    const type = f!.isSwitch ? "BOOLEAN" : e.type;
    if (!FIELD_TYPES.includes(type)) fail(`Unknown type for "${e.tag}".`);
    const used = scan.fields.find((x) => x.tag === e.tag)?.formatters ?? [];
    const bad = used.filter((u) => !FORMATTERS_FOR[type].includes(u as never));
    if (bad.length) fail(`"${label}" is used with |${bad.join(", |")} in the document, which doesn't suit the type ${type.toLowerCase().replace("_", " ")}.`);
    if (!["AIRTABLE", "FIXED", "ASK"].includes(e.source)) fail(`Pick where "${label}" comes from.`);
    if (e.source === "AIRTABLE" && !e.airtableId) fail(`Pick the Airtable field for "${label}".`);
    if (e.source === "FIXED" && !(e.defaultVal ?? "").trim()) fail(`"${label}" is a fixed value; enter it.`);
    if (e.min != null && e.max != null && e.min > e.max) fail(`"${label}": the minimum is more than the maximum.`);
    await db.templateField.update({
      where: { id: f!.id },
      data: {
        label: label.slice(0, 80),
        type,
        required: f!.isSwitch ? false : !!e.required,
        help: (e.help ?? "").slice(0, 300),
        defaultVal: (e.defaultVal ?? "").slice(0, 20_000),
        min: e.min ?? null,
        max: e.max ?? null,
        locked: !!e.locked,
        source: e.source,
        airtableId: e.source === "AIRTABLE" ? (e.airtableId ?? "") : "",
      },
    });
  }
}

export type PartyEdit = { signer: number; role: string; source: "LEAD" | "SIGNATORY" | "TYPED"; nameField?: string; emailField?: string; companyField?: string; userId?: string | null };

/** TPL-4: who signs, where they come from, and the order. */
export async function saveParties(actor: User, versionId: string, parties: PartyEdit[], signingOrder: "SEQUENTIAL" | "PARALLEL") {
  admin(actor);
  const v = await versionFull(versionId);
  for (const p of parties) {
    const row = v.parties.find((x) => x.signer === p.signer);
    if (!row) fail(`Signer ${p.signer} isn't in this template.`);
    if (!p.role.trim()) fail(`Name signer ${p.signer}'s role (for example "Client").`);
    if (p.source === "LEAD" && !p.emailField) fail(`Signer ${p.signer} comes from the lead: pick the Airtable field with their email.`);
    if (p.source === "SIGNATORY") {
      const u = p.userId ? await db.user.findUnique({ where: { id: p.userId } }) : null;
      if (!u?.active) fail(`Pick the company signatory for signer ${p.signer}.`);
    }
    await db.templateParty.update({
      where: { id: row!.id },
      data: { role: p.role.trim().slice(0, 60), source: p.source, nameField: p.nameField ?? "", emailField: p.emailField ?? "", companyField: p.companyField ?? "", userId: p.source === "SIGNATORY" ? (p.userId ?? null) : null },
    });
  }
  await db.templateVersion.update({ where: { id: versionId }, data: { signingOrder: signingOrder === "PARALLEL" ? "PARALLEL" : "SEQUENTIAL" } });
}

/** Why a version can't be published yet (empty = ready). */
export function publishProblems(v: VersionFull) {
  const out = [...scanOf(v).problems];
  for (const f of v.fields) {
    if (f.source === "AIRTABLE" && !f.airtableId) out.push(`"${f.label}" is mapped to Airtable but no field is picked.`);
    if (f.source === "FIXED" && !f.defaultVal.trim()) out.push(`"${f.label}" is a fixed value but has no value.`);
  }
  for (const p of v.parties) {
    if (p.source === "LEAD" && !p.emailField) out.push(`Signer ${p.signer} (${p.role}): pick the Airtable field with their email.`);
    if (p.source === "SIGNATORY" && !p.userId) out.push(`Signer ${p.signer} (${p.role}): pick the company signatory.`);
  }
  return out;
}

export async function publish(actor: User, versionId: string) {
  admin(actor);
  const v = await versionFull(versionId);
  const problems = publishProblems(v);
  if (problems.length) fail(`This version can't be published yet:\n- ${problems.join("\n- ")}`);
  await db.templateVersion.update({ where: { id: versionId }, data: { published: true, publishedAt: await now() } });
}

export async function archive(actor: User, templateId: string, archived: boolean) {
  admin(actor);
  await db.template.update({ where: { id: templateId }, data: { archived } });
}

export async function rename(actor: User, templateId: string, name: string) {
  admin(actor);
  if (!name.trim()) fail("Give the template a name.");
  await db.template.update({ where: { id: templateId }, data: { name: name.trim().slice(0, 120) } });
}

export const versionBytes = (v: Pick<TemplateVersion, "storageKey">) => readBytes(v.storageKey);

/** A sample value for each type, for "Test fill" (TPL-7). */
function sample(f: TemplateField): Value {
  if (f.defaultVal) return f.defaultVal;
  switch (f.type as FieldType) {
    case "MONEY":
      return f.min ?? 2500;
    case "NUMBER":
      return 12;
    case "PERCENT":
      return 12.5;
    case "DATE":
      return "2026-12-01";
    case "EMAIL":
      return "client@example.com";
    case "PHONE":
      return "4155550134";
    case "LONG_TEXT":
      return `Sample ${f.label.toLowerCase()}.\nA second line.`;
    default:
      return `[${f.label}]`;
  }
}

/** TPL-7: the PDF with sample values and every optional section switched on. */
export async function testFill(actor: User, versionId: string) {
  admin(actor);
  const v = await versionFull(versionId);
  const values: Record<string, Value> = {};
  const switches: Record<string, boolean> = {};
  for (const f of v.fields) {
    if (f.isSwitch) switches[f.tag] = true;
    else values[f.tag] = sample(f);
  }
  const docx = fillTemplate(await versionBytes(v), v.fields.filter((f) => !f.isSwitch).map((f) => ({ tag: f.tag, type: f.type as FieldType })), values, switches);
  return toPdf(docx);
}

/** Templates for lists and the MCP tools: published ones (or all, for Admins). */
export async function listTemplates(includeUnpublished = false) {
  const templates = await db.template.findMany({ where: includeUnpublished ? {} : { archived: false }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  const out = [];
  for (const t of templates) {
    const versions = await db.templateVersion.findMany({ where: { templateId: t.id }, orderBy: { version: "desc" } });
    const pub = versions.find((v) => v.published);
    if (!pub && !includeUnpublished) continue;
    out.push({ template: t, versions, published: pub ?? null });
  }
  return out;
}
