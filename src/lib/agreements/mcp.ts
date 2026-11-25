// The MCP tools Grok uses (FRD §12). Each one calls the same core functions as the web pages, so it can only do what
// the signed-in user can. No tool accepts contract wording: values go only into named template fields and switches.
import { z } from "zod";
import { defineTool, ToolError } from "../mcp/tool";
import { db } from "../db";
import { now } from "../clock";
import { appUrl } from "../email";

import { listTemplates, versionFull, scanOf } from "../templates/core";
import { findLeads } from "../airtable/connection";
import { recordIdFrom } from "../airtable/client";
import { fileUrlParams } from "../sign/tokens";
import * as A from "./core";

const values = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Named template fields and their values, e.g. {\"depositAmount\": 2500, \"startDate\": \"2027-01-05\"}. Names come from list_templates.");
const switches = z.record(z.string(), z.boolean()).optional().describe("Optional sections to switch on or off, e.g. {\"includeRushFee\": true}. Names come from list_templates.");
const parties = z
  .array(z.object({ signer: z.number().int().min(1), name: z.string().optional(), email: z.string().optional(), company: z.string().optional() }))
  .optional()
  .describe("Signer details to set or correct (for parties typed at send time, or a corrected email).");

async function agreementOut(actor: Parameters<typeof A.load>[0], id: string) {
  const a = await A.load(actor, id);
  const v = await versionFull(a.templateVersionId);
  const { fields, switches: sw } = A.fieldViews(v, a);
  const env = a.envelopeId ? await db.signEnvelope.findUnique({ where: { id: a.envelopeId } }) : null;
  const signers = env ? await db.signSigner.findMany({ where: { envelopeId: env.id }, orderBy: { order: "asc" } }) : [];
  return {
    agreement_id: a.id,
    reference: a.reference,
    title: a.title,
    status: a.status,
    status_label: A.STATUS_LABEL[a.status] ?? a.status,
    template: `${v.template.name} v${v.version}`,
    lead: a.leadLabel,
    fields: fields.filter((f) => f.needed).map((f) => ({ name: f.tag, label: f.label, type: f.type, value: f.value, display: f.display, source: f.source, required: f.required, locked: f.locked, ...(f.error ? { problem: f.error } : {}) })),
    switches: sw.map((s) => ({ name: s.tag, label: s.label, on: s.on })),
    signers: env
      ? signers.map((s) => ({ order: s.order, role: s.role, name: s.name, email: s.email, status: s.status, signed_at: s.signedAt?.toISOString() ?? null }))
      : A.partiesOf(a).map((p) => ({ order: p.signer, role: p.role, name: p.name, email: p.email, status: "NOT_SENT", signed_at: null })),
    missing: A.missingOf(v, a).map((m) => `${m.tag} (${m.label})${m.reason !== "needs a value" ? `: ${m.reason}` : ""}`),
    sign_by: env?.expiresAt?.toISOString().slice(0, 10) ?? null,
    page_url: `${appUrl()}/agreements/${a.id}`,
  };
}

const agreementShape = {
  agreement_id: z.string(),
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  status_label: z.string(),
  template: z.string(),
  lead: z.string(),
  fields: z.array(z.any()),
  switches: z.array(z.any()),
  signers: z.array(z.any()),
  missing: z.array(z.string()).describe("Required values still empty, as name (label). Ask the user for these, then call set_values."),
  sign_by: z.string().nullable(),
  page_url: z.string(),
};

/** A preview/download link valid 10 minutes, for the user to open (it's signed; no login needed). */
async function fileLink(kind: "preview" | "signed", agreementId: string) {
  const p = fileUrlParams(`${kind}:${agreementId}`, await now(), 10);
  return { url: `${appUrl()}/api/agreements/${agreementId}/file?kind=${kind}&exp=${p.exp}&sig=${encodeURIComponent(p.sig)}`, expires_at: p.expiresAt.toISOString() };
}

export const tools = [
  defineTool({
    name: "list_templates",
    title: "List agreement templates",
    description: "Published agreement templates with their fields (name, label, type, required, where the value comes from: Airtable, a fixed value or the user; allowed range), their optional sections (switches) and their signing parties. Call this first to learn the field names prepare_agreement and set_values accept.",
    kind: "read",
    input: {},
    output: { items: z.array(z.any()) },
    run: async () => {
      const list = await listTemplates(false);
      const items = [];
      for (const t of list) {
        const v = await versionFull(t.published!.id);
        const scan = scanOf(v);
        items.push({
          template_id: t.template.id,
          name: t.template.name,
          version: v.version,
          fields: v.fields
            .filter((f) => !f.isSwitch)
            .map((f) => ({
              name: f.tag,
              label: f.label,
              type: f.type,
              required: f.required,
              comes_from: f.source === "AIRTABLE" ? "airtable" : f.source === "FIXED" ? "fixed" : f.defaultVal ? "default (user may change)" : "user",
              ...(f.min != null ? { min: f.min } : {}),
              ...(f.max != null ? { max: f.max } : {}),
              ...(f.locked ? { locked: true } : {}),
              ...(f.help ? { help: f.help } : {}),
              ...(scan.fields.find((x) => x.tag === f.tag)?.inSections.length ? { only_when: scan.fields.find((x) => x.tag === f.tag)!.inSections.map((s) => (s.startsWith("!") ? `${s.slice(1)} is off` : `${s} is on`)).join(" or ") } : {}),
            })),
          switches: v.fields.filter((f) => f.isSwitch).map((f) => ({ name: f.tag, label: f.label, default: f.defaultVal === "true" })),
          parties: v.parties.map((p) => ({ signer: p.signer, role: p.role, from: p.source === "LEAD" ? "the lead in Airtable" : p.source === "SIGNATORY" ? "company signatory" : "typed when sending" })),
          signing_order: v.signingOrder.toLowerCase(),
        });
      }
      return { items };
    },
  }),

  defineTool({
    name: "find_leads",
    title: "Find leads in Airtable",
    description: "Search the client's Airtable leads table by name, company or email (or pass a record ID / Airtable URL). Returns up to 20 matches with their record IDs, for prepare_agreement.",
    kind: "read",
    input: { query: z.string().min(1).max(200).describe("Name, company, email, record ID (rec...) or Airtable record URL.") },
    output: { items: z.array(z.object({ record_id: z.string(), label: z.string(), detail: z.string() })) },
    run: async (_actor, { query }) => {
      const id = recordIdFrom(query);
      if (id) {
        const { lead } = await import("../airtable/connection");
        const r = await lead(id);
        return { items: [{ record_id: r.summary.id, label: r.summary.label, detail: r.summary.detail }] };
      }
      return { items: (await findLeads(query, 20)).map((l) => ({ record_id: l.id, label: l.label, detail: l.detail })) };
    },
  }),

  defineTool({
    name: "prepare_agreement",
    title: "Prepare an agreement (draft)",
    description:
      "Create a draft agreement from a template and an Airtable lead. Values come from the Airtable mapping; any values and switches you pass are applied as the user's. Returns every field with its value and source, and `missing`: required values still empty. Ask the user for exactly those, then call set_values. Nothing is sent.",
    kind: "write",
    input: {
      template: z.string().describe("Template ID or exact name, from list_templates."),
      lead_record_id: z.string().describe("Airtable record ID from find_leads (rec...)."),
      values,
      switches,
      parties,
    },
    output: agreementShape,
    run: async (actor, i) => {
      const list = await listTemplates(false);
      const t = list.find((x) => x.template.id === i.template) ?? list.find((x) => x.template.name.toLowerCase() === i.template.trim().toLowerCase());
      if (!t) throw new ToolError(`No published template "${i.template}". Call list_templates for the names.`);
      const rec = recordIdFrom(i.lead_record_id);
      if (!rec) throw new ToolError("lead_record_id must be an Airtable record ID (rec followed by 14 characters). Use find_leads.");
      const a = await A.createAgreement(actor, { templateId: t.template.id, recordId: rec, values: i.values ?? undefined, switches: i.switches ?? undefined, parties: i.parties ?? undefined });
      return agreementOut(actor, a.id);
    },
  }),

  defineTool({
    name: "set_values",
    title: "Set values on a draft agreement",
    description: "Fill or change named fields, optional sections and signer details on a draft agreement. Unknown names and invalid values are refused by name. Changing a value that came from Airtable marks it as overridden (Airtable itself isn't changed); locked fields can't be changed. Returns the agreement with what's still missing.",
    kind: "write",
    input: { agreement_id: z.string(), values, switches, parties },
    output: agreementShape,
    run: async (actor, i) => {
      await A.setValues(actor, i.agreement_id, i.values ?? {}, i.switches ?? {}, i.parties ?? []);
      return agreementOut(actor, i.agreement_id);
    },
  }),

  defineTool({
    name: "get_agreement",
    title: "Get an agreement",
    description: "An agreement's status, fields, signers and their progress, plus a preview link to the PDF (valid 10 minutes) for the user to open.",
    kind: "read",
    input: { agreement_id: z.string() },
    output: { ...agreementShape, preview_url: z.string(), preview_expires_at: z.string() },
    run: async (actor, { agreement_id }) => {
      const out = await agreementOut(actor, agreement_id);
      const link = await fileLink("preview", agreement_id);
      return { ...out, preview_url: link.url, preview_expires_at: link.expires_at };
    },
  }),

  defineTool({
    name: "send_agreement",
    title: "Send an agreement for signature",
    description:
      "Send a draft agreement to every signer by email. Refuses while anything is missing. Call it first WITHOUT confirm: it returns a summary (signers, key values, sign-by date) and sends nothing. Show that summary to the user, and only after they agree call again with confirm: true.",
    kind: "write",
    input: {
      agreement_id: z.string(),
      message: z.string().max(2000).optional().describe("A short note to the signers, shown in the email. Never contract terms."),
      sign_by: z.string().optional().describe("Sign-by date, YYYY-MM-DD. Default: the company setting (usually 14 days)."),
      confirm: z.boolean().optional().describe("true only after the user has seen the summary and agreed to send."),
    },
    output: { sent: z.boolean(), summary: z.any(), agreement: z.any().optional(), note: z.string() },
    run: async (actor, i) => {
      const summary = await A.sendSummary(actor, i.agreement_id, { signBy: i.sign_by });
      if (summary.missing.length) throw new ToolError(`Can't send yet. Still needed: ${summary.missing.map((m) => `${m.tag} (${m.label})${m.reason !== "needs a value" ? `: ${m.reason}` : ""}`).join(", ")}. Ask the user, then call set_values.`);
      if (i.confirm !== true) return { sent: false, summary, note: "Nothing has been sent. Show this summary to the user; if they agree, call send_agreement again with confirm: true." };
      await A.sendAgreement(actor, i.agreement_id, { message: i.message, signBy: i.sign_by });
      return { sent: true, summary, agreement: await agreementOut(actor, i.agreement_id), note: "Sent. Each signer has an email with a secure link." };
    },
  }),

  defineTool({
    name: "list_agreements",
    title: "List agreements",
    description: "The user's agreements (all agreements, for Admins), newest first. Filter by status (DRAFT, SENT, PARTIALLY_SIGNED, COMPLETED, DECLINED, VOIDED, EXPIRED), by lead (name or record ID) or by creation date.",
    kind: "read",
    input: {
      status: z.string().optional(),
      lead: z.string().optional(),
      since: z.string().optional().describe("YYYY-MM-DD"),
    },
    output: { items: z.array(z.any()) },
    run: async (actor, i) => {
      const since = i.since ? new Date(`${i.since.slice(0, 10)}T00:00:00Z`) : undefined;
      if (since && Number.isNaN(since.getTime())) throw new ToolError("since must be a date (YYYY-MM-DD).");
      const rows = await A.listAgreements(actor, { status: i.status?.toUpperCase(), lead: i.lead, since }, 100);
      return { items: rows.map((a) => ({ agreement_id: a.id, reference: a.reference, title: a.title, lead: a.leadLabel, status: a.status, created: a.createdAt.toISOString().slice(0, 10) })) };
    },
  }),

  defineTool({
    name: "remind",
    title: "Remind signers",
    description: "Re-email whoever's turn it is to sign, with a fresh link.",
    kind: "write",
    input: { agreement_id: z.string() },
    output: { reminded: z.number() },
    run: async (actor, { agreement_id }) => {
      const n = await A.remind(actor, agreement_id);
      if (!n) throw new ToolError("Nobody is waiting to sign.");
      return { reminded: n };
    },
  }),

  defineTool({
    name: "void_agreement",
    title: "Void an agreement",
    description: "Cancel an agreement that's a draft or out for signature. Signers are told, with the reason.",
    kind: "write",
    input: { agreement_id: z.string(), reason: z.string().min(3).max(500) },
    needsConfirm: () => "Voiding cancels the agreement, and every signer who was asked to sign is emailed with the reason.",
    output: { voided: z.boolean() },
    run: async (actor, { agreement_id, reason }) => {
      await A.voidAgreement(actor, agreement_id, reason);
      return { voided: true };
    },
  }),

  defineTool({
    name: "download_signed",
    title: "Link to the signed PDF",
    description: "A link (valid 10 minutes) to the final signed PDF with its certificate of completion, for the user to open.",
    kind: "read",
    input: { agreement_id: z.string() },
    output: { url: z.string(), expires_at: z.string() },
    run: async (actor, { agreement_id }) => {
      const a = await A.load(actor, agreement_id);
      if (a.status !== "COMPLETED") throw new ToolError(`It isn't signed yet (status: ${A.STATUS_LABEL[a.status] ?? a.status}).`);
      return fileLink("signed", agreement_id);
    },
  }),
];
