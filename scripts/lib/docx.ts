// Builds small .docx files for tests and the demo seed. Each paragraph is a list of runs, so tests can split a tag
// across runs the way Word does.
import PizZip from "pizzip";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function makeDocx(paragraphs: (string | string[])[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p>${(Array.isArray(p) ? p : [p]).map((r) => `<w:r><w:t xml:space="preserve">${esc(r)}</w:t></w:r>`).join("")}</w:p>`)
    .join("");
  const zip = new PizZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: "nodebuffer" }) as Buffer;
}

/** A small service agreement used by tests and the demo seed. */
export const SAMPLE_AGREEMENT: (string | string[])[] = [
  "SERVICE AGREEMENT",
  "This Service Agreement is made on {{agreementDate|date}} between {{companyName}} (the Company) and {{clientName}} of {{clientCompany}} (the Client).",
  ["1. Deposit. The Client will pay a deposit of {{deposit", "Amount|usd}} ({{depositAmount|usdWords}}) before work starts on {{startDate|date}}."],
  "2. Scope. {{scopeOfWork|lines}}",
  "{{#includeRushFee}}3. Rush fee. A rush fee of {{rushFee|usd}} applies.{{/includeRushFee}}",
  "{{^includeRushFee}}3. Turnaround. Standard turnaround applies.{{/includeRushFee}}",
  "Notices go to {{clientEmail|lower}}.",
  "",
  "Client: {{sig:1}}  Date: ________",
  "Name: {{name:1}}",
  "",
  "Company: {{sig:2}}  Date: ________",
  "Title: {{title:2}}",
];
