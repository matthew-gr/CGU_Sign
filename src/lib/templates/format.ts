// Formatters and field types (FRD §6). Pure and deterministic: the same value always gives the same text.

export const FIELD_TYPES = ["TEXT", "LONG_TEXT", "MONEY", "NUMBER", "PERCENT", "DATE", "EMAIL", "PHONE", "BOOLEAN"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const TYPE_LABEL: Record<FieldType, string> = {
  TEXT: "Text",
  LONG_TEXT: "Long text",
  MONEY: "Money (USD)",
  NUMBER: "Number",
  PERCENT: "Percent",
  DATE: "Date",
  EMAIL: "Email",
  PHONE: "Phone",
  BOOLEAN: "Yes/no",
};

export const FORMATTERS = ["usd", "usdWords", "date", "dateShort", "upper", "lower", "title", "number", "percent", "phone", "lines"] as const;
export type Formatter = (typeof FORMATTERS)[number];

/** Which formatters make sense for each type (checked when an Admin describes a field). */
export const FORMATTERS_FOR: Record<FieldType, Formatter[]> = {
  TEXT: ["upper", "lower", "title", "lines"],
  LONG_TEXT: ["lines", "upper", "lower"],
  MONEY: ["usd", "usdWords", "number"],
  NUMBER: ["number", "usdWords"],
  PERCENT: ["percent", "number"],
  DATE: ["date", "dateShort"],
  EMAIL: ["lower"],
  PHONE: ["phone"],
  BOOLEAN: [],
};

/** A guess at a field's type from the formatters used with it in the document. */
export function guessType(tag: string, formatters: string[]): FieldType {
  if (formatters.some((f) => f === "usd" || f === "usdWords")) return "MONEY";
  if (formatters.some((f) => f === "date" || f === "dateShort")) return "DATE";
  if (formatters.includes("percent")) return "PERCENT";
  if (formatters.includes("phone")) return "PHONE";
  if (formatters.includes("lines")) return "LONG_TEXT";
  if (formatters.includes("number")) return "NUMBER";
  if (/email/i.test(tag)) return "EMAIL";
  if (/phone|mobile/i.test(tag)) return "PHONE";
  if (/date$|Date[A-Z]?/.test(tag)) return "DATE";
  if (/amount|fee|price|deposit|total|cost/i.test(tag)) return "MONEY";
  return "TEXT";
}

/** "depositAmount" -> "Deposit amount" */
export const labelFor = (tag: string) => {
  const words = tag.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// ---------- numbers in words (US checks style) ----------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion"];

function under1000(n: number) {
  const out: string[] = [];
  if (n >= 100) {
    out.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) out.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ""));
  else if (n > 0) out.push(ONES[n]);
  return out.join(" ");
}

/** 12500 -> "twelve thousand five hundred" (whole numbers). */
export function numberWords(n: number) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "zero";
  const parts: string[] = [];
  let i = 0;
  while (n > 0 && i < SCALES.length) {
    const chunk = n % 1000;
    if (chunk) parts.unshift(`${under1000(chunk)}${SCALES[i] ? ` ${SCALES[i]}` : ""}`);
    n = Math.floor(n / 1000);
    i++;
  }
  return parts.join(" ");
}

/** 12500 -> "twelve thousand five hundred dollars and 00/100" */
export function usdWords(n: number) {
  const cents = Math.round(Math.abs(n) * 100);
  const dollars = Math.floor(cents / 100);
  return `${numberWords(dollars)} dollar${dollars === 1 ? "" : "s"} and ${String(cents % 100).padStart(2, "0")}/100`;
}

const fmtNumber = (n: number, digits = 2) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
export const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-11-24" -> "November 24, 2026" (no time zones involved: a date is a calendar date). */
export const dateLongOf = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
export const dateShortOf = (ymd: string) => {
  const [y, m, d] = ymd.split("-");
  return `${m}/${d}/${y}`;
};

export function phone(s: string) {
  const d = s.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : s.trim();
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

// ---------- typed values ----------

/** A value as stored with an agreement: strings for text, dates as YYYY-MM-DD, numbers as numbers, yes/no as booleans. */
export type Value = string | number | boolean | null;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Parse what a person typed (or a raw value) into a field's type. Returns an error message instead when it can't. */
export function parseValue(type: FieldType, raw: unknown): { value: Value } | { error: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return { value: null };
  switch (type) {
    case "MONEY":
    case "NUMBER":
    case "PERCENT": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,%\s]/g, ""));
      if (!Number.isFinite(n)) return { error: "must be a number" };
      if (type === "MONEY") {
        if (n < 0) return { error: "can't be negative" };
        if (Math.round(n * 100) !== n * 100 && Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return { error: "can have at most 2 decimals" };
        return { value: Math.round(n * 100) / 100 };
      }
      return { value: n };
    }
    case "DATE": {
      let s = String(raw).trim();
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      if (us) s = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) s = s.slice(0, 10);
      if (!YMD.test(s)) return { error: "must be a date (YYYY-MM-DD or MM/DD/YYYY)" };
      const d = new Date(`${s}T12:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { error: "isn't a real date" };
      return { value: s };
    }
    case "EMAIL": {
      const s = String(raw).trim().toLowerCase();
      return EMAIL.test(s) ? { value: s } : { error: "must be a valid email address" };
    }
    case "BOOLEAN": {
      if (typeof raw === "boolean") return { value: raw };
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1", "on", "checked"].includes(s)) return { value: true };
      if (["false", "no", "n", "0", "off", ""].includes(s)) return { value: false };
      return { error: "must be yes or no" };
    }
    case "PHONE":
    case "TEXT":
    case "LONG_TEXT":
    default: {
      const s = String(raw);
      const max = type === "LONG_TEXT" ? 20_000 : 1_000;
      if (s.length > max) return { error: `is too long (over ${max} characters)` };
      return { value: type === "LONG_TEXT" ? s.replace(/\r\n/g, "\n").trim() : s.replace(/\s+/g, " ").trim() };
    }
  }
}

/** The text printed for a value, with an optional formatter (otherwise the type's default). */
export function formatValue(type: FieldType, v: Value, formatter?: string): string {
  if (v === null || v === undefined || v === "") return "";
  const f = formatter as Formatter | undefined;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    switch (f) {
      case "usd":
        return usd(v);
      case "usdWords":
        return usdWords(v);
      case "percent":
        return `${fmtNumber(v, 4)}%`;
      case "number":
        return fmtNumber(v);
      default:
        return type === "MONEY" ? usd(v) : type === "PERCENT" ? `${fmtNumber(v, 4)}%` : fmtNumber(v, 6);
    }
  }
  const s = String(v);
  switch (f) {
    case "date":
      return YMD.test(s) ? dateLongOf(s) : s;
    case "dateShort":
      return YMD.test(s) ? dateShortOf(s) : s;
    case "upper":
      return s.toUpperCase();
    case "lower":
      return s.toLowerCase();
    case "title":
      return titleCase(s);
    case "phone":
      return phone(s);
    case "lines":
      return s;
    default:
      if (type === "DATE" && YMD.test(s)) return dateLongOf(s);
      if (type === "PHONE") return phone(s);
      return s;
  }
}
