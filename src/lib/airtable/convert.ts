// AIR-4: Airtable values into template field values. Deterministic and documented:
//   currency, number, percent, rating, count, autonumber   -> numbers (percent fields: 0.125 -> 12.5)
//   date, dateTime, createdTime, lastModifiedTime          -> dates (dateTime in the company's time zone)
//   single select                                          -> its option text
//   multiple selects, lookups and rollups with many values -> joined with ", "
//   checkbox                                               -> yes/no
//   collaborators                                          -> names
//   attachments, buttons and AI fields                     -> can't be mapped
// A value that can't be converted to the template field's type counts as missing, with the reason.
import { parseValue, type FieldType, type Value } from "../templates/format";
import { ymdIn } from "../tz";
import type { AirtableField } from "./client";

export const UNMAPPABLE = new Set(["multipleAttachments", "button", "aiText", "externalSyncSource"]);

export const AIRTABLE_TYPE_LABEL: Record<string, string> = {
  singleLineText: "Text",
  multilineText: "Long text",
  richText: "Rich text",
  email: "Email",
  url: "URL",
  phoneNumber: "Phone",
  number: "Number",
  currency: "Currency",
  percent: "Percent",
  rating: "Rating",
  duration: "Duration",
  autoNumber: "Auto number",
  count: "Count",
  date: "Date",
  dateTime: "Date and time",
  createdTime: "Created time",
  lastModifiedTime: "Last modified",
  checkbox: "Checkbox",
  singleSelect: "Single select",
  multipleSelects: "Multiple select",
  singleCollaborator: "Collaborator",
  multipleCollaborators: "Collaborators",
  createdBy: "Created by",
  lastModifiedBy: "Modified by",
  multipleRecordLinks: "Linked records",
  multipleLookupValues: "Lookup",
  rollup: "Rollup",
  formula: "Formula",
  barcode: "Barcode",
  multipleAttachments: "Attachments (can't be mapped)",
  button: "Button (can't be mapped)",
  aiText: "AI field (can't be mapped)",
};

/** Flatten any Airtable cell value to a plain scalar or a list of scalars. */
function flatten(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const items = v.map(flatten).flat().filter((x) => x !== null && x !== undefined && x !== "");
    if (!items.length) return null;
    return items.length === 1 ? items[0] : items;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("name" in o && typeof o.name === "string") return o.name; // collaborator, select (some APIs)
    if ("text" in o && typeof o.text === "string") return o.text; // barcode
    if ("value" in o) return flatten(o.value); // AI text, special values
    if ("label" in o && typeof o.label === "string") return o.label; // button
    if ("error" in o) return null; // formula error
    return null;
  }
  return v;
}

export type Converted = { value: Value; error?: undefined } | { value: null; error: string };

/** One Airtable value into a template field's type. `zone`: the company's time zone, for dateTime fields. */
export function convert(field: AirtableField | undefined, raw: unknown, type: FieldType, zone: string): Converted {
  if (!field) return { value: null, error: "the mapped Airtable field no longer exists" };
  if (UNMAPPABLE.has(field.type)) return { value: null, error: `${AIRTABLE_TYPE_LABEL[field.type] ?? field.type} fields can't be used` };
  let v = flatten(raw);
  if (v === null || v === "") return { value: null };
  if (Array.isArray(v)) {
    if (type === "MONEY" || type === "NUMBER" || type === "PERCENT") {
      if (v.length === 1) v = v[0];
      else return { value: null, error: `"${field.name}" has ${v.length} values; a number needs exactly one` };
    } else if (type === "DATE") {
      v = v[0];
    } else if (type === "BOOLEAN") {
      v = v.some((x) => x === true || x === "true");
    } else v = v.map(String).join(", ");
  }
  // Percent fields store 0.125 for 12.5%.
  if (field.type === "percent" && typeof v === "number" && type === "PERCENT") v = Math.round(v * 1e8) / 1e6;
  if (type === "DATE" && typeof v === "string" && /T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) v = ymdIn(d, zone);
  }
  if (type === "BOOLEAN" && field.type === "checkbox") v = v === true;
  if ((type === "TEXT" || type === "LONG_TEXT" || type === "EMAIL" || type === "PHONE") && typeof v !== "string") v = String(v);
  const r = parseValue(type, v);
  if ("error" in r) return { value: null, error: `"${field.name}" value "${String(v).slice(0, 40)}" ${r.error}` };
  return { value: r.value };
}

/** Which template field types can come from an Airtable field type (the mapping dropdown warns otherwise). */
export function compatible(airtableType: string, type: FieldType): boolean {
  if (UNMAPPABLE.has(airtableType)) return false;
  const numeric = ["number", "currency", "percent", "rating", "count", "autoNumber", "duration"];
  if (type === "MONEY" || type === "NUMBER" || type === "PERCENT") return numeric.includes(airtableType) || ["formula", "rollup", "multipleLookupValues", "singleLineText"].includes(airtableType);
  if (type === "DATE") return ["date", "dateTime", "createdTime", "lastModifiedTime", "formula", "rollup", "multipleLookupValues", "singleLineText"].includes(airtableType);
  if (type === "BOOLEAN") return ["checkbox", "formula", "multipleLookupValues", "singleSelect"].includes(airtableType);
  return true;
}
