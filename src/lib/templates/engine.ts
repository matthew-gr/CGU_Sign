// The Word template engine (FRD §6). Adapted from GR OS src/lib/contracts/template.ts, with per-template fields instead
// of a fixed tag list, formatters, inverted sections and signer anchors. Pure: bytes in, bytes out; the same template
// and values always give the same .docx bytes (FIL-6).
//
//   {{name}}                field              {{name|usd}}  field with a formatter
//   {{#name}}...{{/name}}   shown when yes     {{^name}}...{{/name}}  shown when no/empty
//   {{sig:N}} {{initials:N}} {{date:N}} {{name:N}} {{title:N}} {{text:N:Label}} {{check:N:Label}}
//                           signing anchors: left in the text for Sign to place fields on
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { FORMATTERS, formatValue, type FieldType, type Value } from "./format";

const PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ANCHOR = /^(sig|initials|date|name|title|text|check)\s*:\s*(\d{1,2})(\s*:\s*[^{}]{0,60})?$/i;

/** The visible text of an XML part (runs joined), so tags Word split across runs are still found. */
const textOf = (xml: string) => xml.replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** inSections: "x" inside {{#x}}, "!x" inside {{^x}}. Empty when the field is (also) used outside every section. */
export type ScanField = { tag: string; formatters: string[]; count: number; inSections: string[] };
export type Scan = {
  fields: ScanField[]; // plain fields, in order of first appearance
  sections: string[]; // switch names ({{#x}} or {{^x}})
  anchors: { kind: string; signer: number; label: string }[];
  signers: number[]; // signer numbers that have anchors, sorted
  problems: string[]; // empty = the template can be published
};

function openZip(docx: Buffer) {
  let zip: PizZip;
  try {
    zip = new PizZip(docx);
  } catch {
    throw new Error("That file isn't a Word document (.docx).");
  }
  if (!zip.file("word/document.xml")) throw new Error("That file isn't a Word document (.docx).");
  return zip;
}

/** TPL-1/TPL-2: every field, section and anchor, and every problem, named. */
export function scanTemplate(docx: Buffer, declaredSigners?: number[]): Scan {
  const zip = openZip(docx);
  const problems: string[] = [];
  const fields = new Map<string, ScanField>();
  const sections = new Set<string>();
  const anchors: Scan["anchors"] = [];
  for (const part of Object.keys(zip.files).filter((n) => PARTS.test(n)).sort()) {
    const where = part.replace(/^word\//, "").replace(/\.xml$/, "");
    const text = textOf(zip.file(part)!.asText());
    const stack: string[] = []; // section names, "!" in front for {{^x}}
    // Stray single braces inside a {{ }} pair, or an unclosed {{, are syntax errors.
    const opens = (text.match(/\{\{/g) ?? []).length;
    const closes = (text.match(/\}\}/g) ?? []).length;
    if (opens !== closes) problems.push(`${where}: there are ${opens} "{{" but ${closes} "}}". Every tag needs both.`);
    for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
      const raw = m[1];
      if (!raw) {
        problems.push(`${where}: an empty tag "{{}}".`);
        continue;
      }
      const a = ANCHOR.exec(raw);
      if (a) {
        anchors.push({ kind: a[1].toLowerCase(), signer: Number(a[2]), label: (a[3] ?? "").replace(/^\s*:\s*/, "").trim() });
        continue;
      }
      if (raw.startsWith("#") || raw.startsWith("^")) {
        const name = raw.slice(1).trim();
        if (!NAME.test(name)) problems.push(`${where}: "{{${raw}}}" isn't a valid section name (letters, digits and _; starts with a letter).`);
        sections.add(name);
        stack.push(raw.startsWith("^") ? `!${name}` : name);
        continue;
      }
      if (raw.startsWith("/")) {
        const name = raw.slice(1).trim();
        const top = stack.pop()?.replace(/^!/, "");
        if (top !== name) problems.push(top ? `${where}: "{{/${name}}}" closes "${top}"'s section; close {{/${top}}} first.` : `${where}: "{{/${name}}}" closes a section that was never opened.`);
        continue;
      }
      const [name, ...fmts] = raw.split("|").map((s) => s.trim());
      if (!NAME.test(name)) {
        problems.push(`${where}: "{{${raw}}}" isn't a valid field name (letters, digits and _; starts with a letter).`);
        continue;
      }
      if (fmts.length > 1) problems.push(`${where}: "{{${raw}}}" has more than one formatter; use one.`);
      for (const f of fmts) if (!(FORMATTERS as readonly string[]).includes(f)) problems.push(`${where}: "{{${raw}}}" uses the unknown formatter "${f}". Known: ${FORMATTERS.join(", ")}.`);
      const cur = fields.get(name) ?? { tag: name, formatters: [], count: 0, inSections: [] };
      cur.count++;
      for (const f of fmts) if (!cur.formatters.includes(f)) cur.formatters.push(f);
      for (const s of stack) if (!cur.inSections.includes(s)) cur.inSections.push(s);
      // A field used both inside and outside a section is always asked for.
      if (!stack.length) cur.inSections = [];
      fields.set(name, cur);
    }
    for (const open of stack.map((s) => s.replace(/^!/, ""))) problems.push(`${where}: the section "{{#${open}}}" is never closed with {{/${open}}}.`);
  }
  for (const s of sections) if (fields.has(s)) problems.push(`"${s}" is used both as a field and as a section switch. Use two names.`);
  const signers = [...new Set(anchors.map((a) => a.signer))].sort((a, b) => a - b);
  if (signers.some((n) => n < 1)) problems.push("Signer numbers start at 1 ({{sig:1}}).");
  signers.forEach((n, i) => {
    if (n !== i + 1) problems.push(`Signer numbers have a gap: there's a signer ${n} but no signer ${i + 1}.`);
  });
  for (const n of declaredSigners ?? signers) if (!anchors.some((a) => a.kind === "sig" && a.signer === n)) problems.push(`Signer ${n} has no {{sig:${n}}} anchor, so there's nowhere for them to sign.`);
  if (!signers.length && !declaredSigners?.length) problems.push("The template has no signature anchors. Add {{sig:1}} (and {{sig:2}} ...) where each party signs.");
  // docxtemplater's own parse, which catches anything left (tags split across paragraphs, for example).
  try {
    new Docxtemplater(new PizZip(docx), { paragraphLoop: true, linebreaks: true, errorLogging: false, delimiters: { start: "{{", end: "}}" }, parser: () => ({ get: () => "" }) });
  } catch (e) {
    const errs = ((e as { properties?: { errors?: { properties?: { explanation?: string } }[] } }).properties?.errors ?? []).map((x) => x.properties?.explanation).filter(Boolean) as string[];
    for (const x of errs.length ? errs : [(e as Error).message]) if (!problems.some((p) => p.includes(x))) problems.push(`Word structure: ${x}`);
  }
  return { fields: [...fields.values()], sections: [...sections], anchors, signers, problems: [...new Set(problems)] };
}

export type FieldDef = { tag: string; type: FieldType };

/**
 * Fill a template. Fields print through their formatter; sections show for true; anchors stay as text so Sign can
 * place signing fields on them. Unknown names print empty (they are checked before generating).
 */
export function fillTemplate(docx: Buffer, defs: FieldDef[], values: Record<string, Value>, switches: Record<string, boolean>): Buffer {
  const types = new Map(defs.map((d) => [d.tag, d.type]));
  const zip = openZip(docx);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
    nullGetter: () => "",
    parser: (tag: string) => {
      const t = tag.trim();
      const a = ANCHOR.exec(t);
      if (a) return { get: () => `{{${t}}}` };
      const [name, fmt] = t.split("|").map((s) => s.trim());
      return {
        get: (scope: unknown, ctx?: { meta?: { part?: { module?: string; type?: string; inverted?: boolean } } }) => {
          if (t === ".") return scope;
          const part = ctx?.meta?.part;
          // Sections ({{#x}} / {{^x}}) read the switch; docxtemplater handles the inversion.
          if (part?.module === "loop" || part?.inverted !== undefined) return switches[name] === true;
          if (name in switches && !types.has(name)) return switches[name] === true;
          const type = types.get(name) ?? "TEXT";
          return formatValue(type, values[name] ?? null, fmt);
        },
      };
    },
  });
  doc.render({});
  const out = doc.getZip();
  const comments = out.file("word/comments.xml");
  if (comments) {
    const xml = comments.asText().replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (m, k: string, f?: string) => (types.has(k) ? xmlEsc(formatValue(types.get(k)!, values[k] ?? null, f)) : m));
    out.file("word/comments.xml", xml);
  }
  // Fixed timestamps on every entry, so filling twice gives identical bytes.
  const fixed = new Date("2000-01-01T00:00:00Z");
  for (const f of Object.values(out.files)) (f as unknown as { date: Date }).date = fixed;
  return out.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The body text of a .docx (tests and checks). */
export function docxBodyText(docx: Buffer) {
  const zip = openZip(docx);
  return textOf(zip.file("word/document.xml")!.asText());
}
