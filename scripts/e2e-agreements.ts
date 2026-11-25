// End-to-end test of the whole flow against a real database and a fake Airtable (FRD §19).
// Run: npx tsx prisma/seed.ts && npx tsx scripts/e2e-agreements.ts
process.env.QUIET_EMAIL = "1";
import { db } from "../src/lib/db";
import { outbox } from "../src/lib/email";
import { requestLogin, verifyLoginCode, SAME_ANSWER } from "../src/lib/auth";
import { setAirtableFetch } from "../src/lib/airtable/client";
import { saveToken, chooseTable, setWriteBack } from "../src/lib/airtable/connection";
import { deliverDue } from "../src/lib/airtable/writeback";
import * as T from "../src/lib/templates/core";
import * as A from "../src/lib/agreements/core";
import * as S from "../src/lib/sign/core";
import { callTool } from "../src/lib/mcp/server";
import { moduleTools } from "../src/lib/mcp/registry.generated";
import { makeDocx, SAMPLE_AGREEMENT } from "./lib/docx";

let failed = 0;
function check(name: string, ok: boolean, extra: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${typeof extra === "string" ? extra : JSON.stringify(extra)}`}`);
  if (!ok) failed++;
}
async function throws(name: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (e) {
    check(name, match.test((e as Error).message), (e as Error).message);
  }
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ---------- a fake Airtable base ----------
const FIELDS = [
  { id: "fldName", name: "Name", type: "singleLineText" },
  { id: "fldCompany", name: "Company", type: "singleLineText" },
  { id: "fldEmail", name: "Email", type: "email" },
  { id: "fldDeposit", name: "Deposit", type: "currency" },
  { id: "fldStart", name: "Start date", type: "date" },
  { id: "fldStatus", name: "Agreement status", type: "singleLineText" },
  { id: "fldLink", name: "Agreement link", type: "url" },
  { id: "fldFiles", name: "Files", type: "multipleAttachments" },
];
const RECORDS: Record<string, Record<string, unknown>> = {
  recJANE0000000001: { fldName: "Jane Smith", fldCompany: "Smith & Co", fldEmail: "jane@example.com", fldDeposit: 2500, fldStart: "2027-01-05" },
  recBOB00000000002: { fldName: "Bob Jones", fldCompany: "Jones LLC", fldEmail: "bob@example.com", fldDeposit: "not a number" },
};
const patches: { id: string; fields: Record<string, unknown> }[] = [];
let failPatches = false;
setAirtableFetch(async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (u.pathname === "/v0/meta/bases") return json({ bases: [{ id: "appBASE", name: "CRM", permissionLevel: "create" }] });
  if (u.pathname === "/v0/meta/bases/appBASE/tables") return json({ tables: [{ id: "tblLeads", name: "Leads", primaryFieldId: "fldName", fields: FIELDS }] });
  const rec = /^\/v0\/appBASE\/tblLeads\/(rec\w+)$/.exec(u.pathname);
  if (rec && init.method === "PATCH") {
    if (failPatches) return json({ error: { type: "SERVER_ERROR", message: "down" } }, 503);
    patches.push({ id: rec[1], fields: JSON.parse(String(init.body)).fields });
    return json({ id: rec[1], fields: {} });
  }
  if (rec) return RECORDS[rec[1]] ? json({ id: rec[1], fields: RECORDS[rec[1]] }) : json({ error: { type: "NOT_FOUND" } }, 404);
  if (u.pathname === "/v0/appBASE/tblLeads") {
    const f = u.searchParams.get("filterByFormula") ?? "";
    const q = /FIND\("([^"]*)"/.exec(f)?.[1] ?? "";
    const recs = Object.entries(RECORDS).filter(([, r]) => !q || Object.values(r).some((v) => String(v).toLowerCase().includes(q)));
    return json({ records: recs.map(([id, fields]) => ({ id, fields })) });
  }
  return json({ error: { type: "NOT_FOUND" } }, 404);
});

async function main() {
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const sender = await db.user.findFirstOrThrow({ where: { role: "SENDER" } });

  // ---------- 1. login ----------
  const r1 = await requestLogin(admin.email, "10.0.0.1", "nonce-a");
  await throws("login: wrong code refused", () => verifyLoginCode(r1.loginId, "000000" === r1.code ? "111111" : "000000"), /isn't right/);
  const u = await verifyLoginCode(r1.loginId, r1.code!);
  check("login: right code works", u.id === admin.id);
  await throws("login: code works once", () => verifyLoginCode(r1.loginId, r1.code!), /expired|isn't right/);
  const r2 = await requestLogin(admin.email, "10.0.0.2", "nonce-b");
  const wrong = r2.code === "123456" ? "654321" : "123456";
  for (let i = 0; i < 4; i++) await verifyLoginCode(r2.loginId, wrong).catch(() => undefined);
  await throws("login: fifth wrong try locks", () => verifyLoginCode(r2.loginId, wrong), /Locked for 15 minutes/);
  await throws("login: locked even with the right code", () => verifyLoginCode(r2.loginId, r2.code!), /Too many wrong codes/);
  const unknown = await requestLogin("nobody@example.com", "10.0.0.3", "nonce-c");
  check("login: unknown email gets the same answer and no email", unknown.code === null && !!unknown.loginId && !outbox.some((m) => m.to.email === "nobody@example.com") && SAME_ANSWER.startsWith("If you have an account"));

  // ---------- 2. Airtable connection ----------
  await saveToken(admin, "patABCDEFGHIJKLMN.0123456789abcdef0123456789abcdef");
  await chooseTable(admin, { baseId: "appBASE", tableId: "tblLeads", searchFields: ["fldName", "fldCompany", "fldEmail"] });
  await throws("airtable: Senders can't change the connection", () => saveToken(sender, "patABCDEFGHIJKLMN.0123456789abcdef0123456789abcdef"), /Admin/);
  await setWriteBack(admin, true, { status: "fldStatus", link: "fldLink" });

  // ---------- 3. templates ----------
  await throws("template: unknown formatter, unclosed section and missing sig:2 are named", () => T.uploadVersion(admin, { name: "Bad", bytes: makeDocx(["{{fee|money}}", "{{#x}}open", "A {{sig:1}}", "B {{name:2}}"]), fileName: "bad.docx" }).then((r) => T.publish(admin, r.version.id)), /unknown formatter "money"[\s\S]*never closed[\s\S]*\{\{sig:2\}\}/);
  await throws("template: Senders can't upload", () => T.uploadVersion(sender, { name: "X", bytes: makeDocx(SAMPLE_AGREEMENT), fileName: "x.docx" }), /Admin/);
  const up = await T.uploadVersion(admin, { name: "Service Agreement", bytes: makeDocx(SAMPLE_AGREEMENT), fileName: "service.docx" });
  const vid = up.version.id;
  check("template: split tag scanned", up.scan.fields.some((f) => f.tag === "depositAmount"));
  const v0 = await T.versionFull(vid);
  const edits: T.FieldEdit[] = v0.fields.map((f) => ({ tag: f.tag, label: f.label, type: f.type as never, required: f.required, source: "ASK" as const, defaultVal: f.defaultVal }));
  const set = (tag: string, p: Partial<T.FieldEdit>) => Object.assign(edits.find((e) => e.tag === tag)!, p);
  set("agreementDate", { type: "DATE", defaultVal: "2026-11-24" });
  set("companyName", { source: "FIXED", defaultVal: "Demo Client LLC" });
  set("clientName", { source: "AIRTABLE", airtableId: "fldName" });
  set("clientCompany", { source: "AIRTABLE", airtableId: "fldCompany", required: false });
  set("depositAmount", { type: "MONEY", source: "AIRTABLE", airtableId: "fldDeposit", min: 500, max: 50000 });
  set("startDate", { type: "DATE", source: "AIRTABLE", airtableId: "fldStart" });
  set("scopeOfWork", { type: "LONG_TEXT" });
  set("rushFee", { type: "MONEY" });
  set("clientEmail", { type: "EMAIL", source: "AIRTABLE", airtableId: "fldEmail", locked: true });
  await T.saveFields(admin, vid, edits);
  await throws("template: publish refused until parties are set", () => T.publish(admin, vid), /signatory/);
  await T.saveParties(admin, vid, [{ signer: 1, role: "Client", source: "LEAD", nameField: "fldName", emailField: "fldEmail", companyField: "fldCompany" }, { signer: 2, role: "Company", source: "SIGNATORY", userId: admin.id }], "SEQUENTIAL");
  await T.publish(admin, vid);
  const tpl = up.version.templateId;

  // ---------- 4. agreement: fill, missing values, overrides, sections ----------
  const a = await A.createAgreement(sender, { templateId: tpl, recordId: "recJANE0000000001" });
  const v = await T.versionFull(a.templateVersionId);
  let missing = A.missingOf(v, a).map((m) => m.tag);
  check("fill: Airtable values used", A.valuesOf(a).depositAmount.value === 2500 && A.valuesOf(a).depositAmount.source === "AIRTABLE" && A.valuesOf(a).companyName.source === "FIXED");
  check("fill: only scope is missing (rush fee is in a switched-off section)", missing.join() === "scopeOfWork", missing);
  await throws("send refused while a value is missing, by name", () => A.sendAgreement(sender, a.id), /Scope of work/);
  await throws("fill: out-of-range deposit refused", () => A.setValues(sender, a.id, { depositAmount: 100 }), /between \$500\.00 and \$50,000\.00/);
  await throws("fill: locked Airtable field can't be overridden", () => A.setValues(sender, a.id, { clientEmail: "other@example.com" }), /locked/);
  await throws("fill: unknown field refused by name", () => A.setValues(sender, a.id, { notAField: 1 }), /"notAField" isn't a field/);
  let b = await A.setValues(sender, a.id, { depositAmount: 3000, scopeOfWork: "Kitchen remodel.\nPermits included." }, { includeRushFee: true });
  check("fill: override marked with the Airtable value", A.valuesOf(b).depositAmount.source === "OVERRIDE" && A.valuesOf(b).depositAmount.original === 2500);
  missing = A.missingOf(v, b).map((m) => m.tag);
  check("fill: switching a section on asks for its fields", missing.join() === "rushFee", missing);
  b = await A.setValues(sender, a.id, { rushFee: 750 });
  check("fill: nothing missing now", A.missingOf(v, b).length === 0, A.missingOf(v, b));
  await throws("access: another Sender can't see it", async () => A.load({ ...sender, id: "someone-else" }, a.id), /not found/);
  const bob = await A.createAgreement(sender, { templateId: tpl, recordId: "recBOB00000000002" });
  const bobDeposit = A.fieldViews(v, bob).fields.find((f) => f.tag === "depositAmount")!;
  check("fill: unconvertible Airtable value counts as missing with the reason", bobDeposit.missing && /must be a number/.test(bobDeposit.error ?? ""), bobDeposit);

  // ---------- 5. generate, deterministic ----------
  const g1 = await A.generate(b);
  const g2 = await A.generate(b);
  check("generate: same .docx bytes twice", Buffer.compare(g1.docx, g2.docx) === 0);
  check("generate: same PDF bytes twice", Buffer.compare(g1.pdf, g2.pdf) === 0);

  // ---------- 6. send, sequential signing ----------
  outbox.length = 0;
  const sent = await A.sendAgreement(sender, a.id, { message: "Thanks!" });
  check("send: agreement shows Sent", sent.status === "SENT" && !!sent.envelopeId);
  const signers = await db.signSigner.findMany({ where: { envelopeId: sent.envelopeId! }, orderBy: { order: "asc" } });
  check("send: signers from the template parties", signers.map((s) => `${s.role}:${s.email}`).join() === `Client:jane@example.com,Company:${admin.email}`, signers);
  check("send: sequential, only signer 1 emailed", outbox.filter((m) => m.subject.startsWith("Please sign")).map((m) => m.to.email).join() === "jane@example.com");
  const fields = await db.signField.findMany({ where: { envelopeId: sent.envelopeId! } });
  check("send: anchors placed signature fields for both signers", signers.every((s) => fields.some((f) => f.signerId === s.id && f.type === "SIGNATURE")), fields.map((f) => f.type));
  await deliverDue();
  check("airtable: write-back Sent", patches.some((p) => p.id === "recJANE0000000001" && p.fields.fldStatus === "Sent"), patches);

  for (const [i, s] of signers.entries()) {
    const code = await S.requestCode(s.id);
    await S.verifyCode(s.id, code);
    await S.markViewed(s.id);
    const myFields = fields.filter((f) => f.signerId === s.id);
    const values = Object.fromEntries(myFields.filter((f) => f.type === "TITLE" || f.type === "TEXT").map((f) => [f.id, "Owner"]));
    if (i === 1) failPatches = true; // the final write-back fails, which must not block completion
    await S.completeSigning(s.id, { values, signature: PNG, initials: PNG, typedName: s.name, consent: true, reachedEnd: true });
    if (i === 0) check("sequential: signer 2 emailed after signer 1", outbox.some((m) => m.to.email === admin.email && m.subject.startsWith("Please sign")));
  }
  const done = await db.agreement.findUniqueOrThrow({ where: { id: a.id } });
  const env = await db.signEnvelope.findUniqueOrThrow({ where: { id: done.envelopeId! } });
  check("complete: agreement and envelope completed despite a failing Airtable write", done.status === "COMPLETED" && env.status === "COMPLETED");
  const fin = await S.fileForStaff(sender, env.id, "final");
  check("complete: final PDF matches its stored SHA-256", S.sniff(fin.bytes) === "application/pdf" && (await import("../src/lib/sign/pdf")).sha256(fin.bytes) === env.finalHash);
  const verdict = await S.verifyFile(null, fin.bytes);
  check("verify: final PDF is genuine", verdict.match === "FINAL");
  const tampered = Buffer.from(fin.bytes);
  tampered[tampered.length - 10] ^= 1;
  check("verify: one changed byte is no match", (await S.verifyFile(null, tampered)).match === "NONE");
  const certText = fin.bytes.toString("latin1");
  check("certificate: no seal anywhere", !/seal/i.test(certText) && !/Kigali|Grow Rwanda/i.test(certText));
  check("complete: everyone emailed with the PDF attached", ["jane@example.com", admin.email].every((e) => outbox.some((m) => m.to.email === e && m.subject.startsWith("Completed") && m.attachments?.length)));
  const w = await db.airtableWrite.findFirst({ where: { agreementId: a.id }, orderBy: { createdAt: "desc" } });
  check("airtable: failed write queued for retry", !!w && !w.doneAt && !!w.nextAt && w.attempts === 1, w);
  failPatches = false;
  await db.airtableWrite.updateMany({ where: { doneAt: null, nextAt: { not: null } }, data: { nextAt: new Date(0) } });
  await deliverDue();
  check("airtable: retry writes Signed", patches.some((p) => p.fields.fldStatus === "Signed"), patches.map((p) => p.fields.fldStatus));

  // ---------- 7. MCP ----------
  const tool = (n: string) => moduleTools.find((t) => t.name === n)!;
  const lt = await callTool(sender, tool("list_templates"), {});
  check("mcp: list_templates", lt.ok && (lt.out as { items: { name: string }[] }).items[0]?.name === "Service Agreement", lt);
  const fl = await callTool(sender, tool("find_leads"), { query: "jane" });
  check("mcp: find_leads", fl.ok && (fl.out as { items: { record_id: string }[] }).items[0]?.record_id === "recJANE0000000001", fl);
  const pr = await callTool(sender, tool("prepare_agreement"), { template: "Service Agreement", lead_record_id: "recJANE0000000001", values: { depositAmount: 2500 }, switches: { includeRushFee: true } });
  const prOut = pr.out as { agreement_id: string; missing: string[] };
  check("mcp: prepare_agreement returns missing by name and label", pr.ok && prOut.missing.join("|") === "scopeOfWork (Scope of work)|rushFee (Rush fee)", pr);
  const lockedTry = await callTool(sender, tool("set_values"), { agreement_id: prOut.agreement_id, values: { clientEmail: "x@example.com" } });
  check("mcp: locked field refused", !lockedTry.ok && /locked/.test(lockedTry.error), lockedTry);
  await callTool(sender, tool("set_values"), { agreement_id: prOut.agreement_id, values: { scopeOfWork: "Deck build.", rushFee: 500 } });
  const s1 = await callTool(sender, tool("send_agreement"), { agreement_id: prOut.agreement_id });
  check("mcp: send without confirm only returns the summary", s1.ok && (s1.out as { sent: boolean }).sent === false && (await db.agreement.findUniqueOrThrow({ where: { id: prOut.agreement_id } })).status === "DRAFT", s1);
  const s2 = await callTool(sender, tool("send_agreement"), { agreement_id: prOut.agreement_id, confirm: true });
  check("mcp: send with confirm sends", s2.ok && (await db.agreement.findUniqueOrThrow({ where: { id: prOut.agreement_id } })).status === "SENT", s2);
  const other = await db.user.create({ data: { email: "other@example.com", name: "Other Sender", role: "SENDER" } });
  const peek = await callTool(other, tool("get_agreement"), { agreement_id: prOut.agreement_id });
  check("mcp: another Sender can't see it", !peek.ok && /not found/i.test(peek.error), peek);
  const v1 = await callTool(sender, tool("void_agreement"), { agreement_id: prOut.agreement_id, reason: "Changed plans" });
  check("mcp: void needs confirm", !v1.ok && /confirm: true/.test(v1.error));
  check("mcp: every call logged", (await db.mcpAudit.count()) >= 9);

  // ---------- 8. uploaded documents (SND-6): a photo becomes a one-page PDF, fields placed by hand, sent ----------
  const photo = await S.createEnvelope(sender, { title: "Change order (photo)", bytes: Buffer.from(PNG.split(",")[1], "base64"), fileName: "change-order.png" });
  check("upload: a PNG becomes a one-page PDF", photo.pageCount === 1 && photo.fileName.endsWith(".pdf"), photo);
  const [ps] = await S.setSigners(sender, photo.id, [{ name: "Jane Smith", email: "jane@example.com" }], "PARALLEL");
  await S.setFields(sender, photo.id, [{ signerId: ps.id, type: "SIGNATURE", page: 1, x: 0.1, y: 0.7, width: 0.4, height: 0.1 }]);
  const sentPhoto = await S.sendEnvelope(sender, photo.id);
  check("upload: sent for signature", sentPhoto.status === "SENT");

  // ---------- 9. click tracking off on real delivery ----------
  const { sendEmail } = await import("../src/lib/email");
  const realFetch = globalThis.fetch;
  let body: { tracking_settings?: { click_tracking?: { enable: boolean }; open_tracking?: { enable: boolean } } } = {};
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response("", { status: 202 });
  }) as typeof fetch;
  Object.assign(process.env, { EMAIL_DELIVERY: "on", SENDGRID_API_KEY: "SG.test", EMAIL_FROM: "Sender <sender@example.com>" });
  await sendEmail({ to: { email: "x@example.com", name: "X" }, subject: "t", body: "b", link: "/s/abc" });
  process.env.EMAIL_DELIVERY = "off";
  globalThis.fetch = realFetch;
  check("email: click and open tracking off", body.tracking_settings?.click_tracking?.enable === false && body.tracking_settings?.open_tracking?.enable === false, body);

  console.log(failed ? `\n${failed} failed` : "\nAll end-to-end tests passed");
}

main()
  .catch((e) => {
    console.error(e);
    failed++;
  })
  .finally(async () => {
    await db.$disconnect();
    process.exit(failed ? 1 : 0);
  });
