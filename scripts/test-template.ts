// Unit tests for the template engine and formatters (no database). Run: npx tsx scripts/test-template.ts
import { createHash } from "node:crypto";
import { docxBodyText, fillTemplate, scanTemplate } from "../src/lib/templates/engine";
import { formatValue, parseValue, usdWords } from "../src/lib/templates/format";
import { makeDocx, SAMPLE_AGREEMENT } from "./lib/docx";

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${extra}`}`);
  if (!ok) failed++;
}

// Formatters
check("usd", formatValue("MONEY", 12500, "usd") === "$12,500.00");
check("usdWords", usdWords(12500) === "twelve thousand five hundred dollars and 00/100", usdWords(12500));
check("usdWords cents", usdWords(2500.5) === "two thousand five hundred dollars and 50/100", usdWords(2500.5));
check("usdWords one", usdWords(1) === "one dollar and 00/100");
check("date", formatValue("DATE", "2026-11-24", "date") === "November 24, 2026");
check("dateShort", formatValue("DATE", "2026-11-24", "dateShort") === "11/24/2026");
check("phone", formatValue("PHONE", "4155550134", "phone") === "(415) 555-0134");
check("percent", formatValue("PERCENT", 12.5, "percent") === "12.5%");
check("number", formatValue("NUMBER", 1250, "number") === "1,250");
check("parse money", JSON.stringify(parseValue("MONEY", "$2,500.00")) === '{"value":2500}');
check("parse money 3 decimals", "error" in parseValue("MONEY", "1.005"));
check("parse negative money", "error" in parseValue("MONEY", -5));
check("parse US date", JSON.stringify(parseValue("DATE", "1/5/2027")) === '{"value":"2027-01-05"}');
check("parse bad date", "error" in parseValue("DATE", "2026-02-30"));
check("parse email", "error" in parseValue("EMAIL", "nope"));

// Scan
const docx = makeDocx(SAMPLE_AGREEMENT);
const scan = scanTemplate(docx);
check("scan: no problems", scan.problems.length === 0, JSON.stringify(scan.problems));
check("scan: split tag found", scan.fields.some((f) => f.tag === "depositAmount" && f.formatters.includes("usd") && f.formatters.includes("usdWords")), JSON.stringify(scan.fields));
check("scan: section", scan.sections.includes("includeRushFee"));
check("scan: rushFee only inside section", scan.fields.find((f) => f.tag === "rushFee")?.inSections.join() === "includeRushFee");
check("scan: signers", scan.signers.join() === "1,2");

const bad = scanTemplate(makeDocx(["Hello {{name|money}}", "{{#open}}never closed", "Client {{sig:1}}", "Third {{sig:3}}"]));
check("scan: unknown formatter named", bad.problems.some((p) => p.includes('unknown formatter "money"')), JSON.stringify(bad.problems));
check("scan: unclosed section named", bad.problems.some((p) => p.includes('"{{#open}}" is never closed')), JSON.stringify(bad.problems));
check("scan: signer gap named", bad.problems.some((p) => p.includes("no signer 2")), JSON.stringify(bad.problems));
const noSig2 = scanTemplate(makeDocx(["A {{sig:1}}", "B {{name:2}}"]));
check("scan: missing sig:2 named", noSig2.problems.some((p) => p.includes("{{sig:2}}")), JSON.stringify(noSig2.problems));

// Fill
const defs = [
  { tag: "agreementDate", type: "DATE" as const },
  { tag: "companyName", type: "TEXT" as const },
  { tag: "clientName", type: "TEXT" as const },
  { tag: "clientCompany", type: "TEXT" as const },
  { tag: "depositAmount", type: "MONEY" as const },
  { tag: "startDate", type: "DATE" as const },
  { tag: "scopeOfWork", type: "LONG_TEXT" as const },
  { tag: "rushFee", type: "MONEY" as const },
  { tag: "clientEmail", type: "EMAIL" as const },
];
const values = { agreementDate: "2026-11-24", companyName: "Acme Services LLC", clientName: "Jane Smith", clientCompany: "Smith & Co", depositAmount: 2500, startDate: "2027-01-05", scopeOfWork: "Kitchen remodel.\nPermits included.", rushFee: 750, clientEmail: "JANE@EXAMPLE.COM" };
const on = fillTemplate(docx, defs, values, { includeRushFee: true });
const text = docxBodyText(on);
check("fill: usd", text.includes("a deposit of $2,500.00 (two thousand five hundred dollars and 00/100)"), text);
check("fill: date", text.includes("made on November 24, 2026"));
check("fill: ampersand kept", text.includes("Smith & Co"));
check("fill: rush section on", text.includes("A rush fee of $750.00 applies.") && !text.includes("Standard turnaround"), text);
check("fill: anchors kept", text.includes("{{sig:1}}") && text.includes("{{title:2}}"));
check("fill: lower", text.includes("jane@example.com"));
const off = docxBodyText(fillTemplate(docx, defs, values, { includeRushFee: false }));
check("fill: rush section off", !off.includes("rush fee") && off.includes("Standard turnaround applies."), off);
const h = (b: Buffer) => createHash("sha256").update(b).digest("hex");
check("fill: deterministic bytes", h(fillTemplate(docx, defs, values, { includeRushFee: true })) === h(on));

console.log(failed ? `\n${failed} failed` : "\nAll template tests passed");
process.exit(failed ? 1 : 0);
