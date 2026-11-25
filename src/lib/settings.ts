// Company settings (Admins edit them on /settings). One JSON row in Setting, merged over the defaults.
import { db } from "./db";

/** ESIGN §101(c) disclosure shown to every signer before they sign. Placeholder wording: the client's US counsel signs it off (FRD §14). */
export const DEFAULT_CONSENT = [
  "By ticking this box you agree to use electronic records and signatures for this agreement. Before you agree, please note:",
  "1. Paper copy. You may ask for a paper copy of this agreement at any time, free of charge, by emailing the sender.",
  "2. Withdrawing consent. You may withdraw your consent to electronic records before you sign by declining to sign, or by telling the sender. Withdrawing consent after signing does not affect the validity of what you have already signed.",
  "3. Scope. This consent covers this agreement and its signing records only.",
  "4. What you need. A current web browser, a device that can open PDF files, and access to the email address this request was sent to.",
  "5. Updating your email. Tell the sender if your email address changes.",
  "Your electronic signature has the same legal effect as a handwritten signature.",
].join("\n");

export type ConsentVersion = { version: number; text: string; at: string };

export type AppSettings = {
  companyName: string;
  productName: string;
  logoUrl: string; // absolute URL or data URL, shown in emails and on signer pages
  brandColor: string;
  timeZone: string; // IANA zone, e.g. America/New_York
  senderName: string; // display name on emails; the address is the verified SendGrid sender
  replyTo: string;
  expiryDays: number; // default sign-by
  dailyReminders: boolean; // remind signers pending 3+ days
  consent: ConsentVersion[]; // newest last; signers accept the newest
  retentionYears: number;
  attachFinalPdf: boolean;
  referencePrefix: string; // SA -> SA-2026-0042
};

export const DEFAULT_SETTINGS: AppSettings = {
  companyName: process.env.COMPANY_NAME || "Your Company",
  productName: "Agreements",
  logoUrl: "",
  brandColor: "#912b8e", // Caregivers United plum
  timeZone: process.env.COMPANY_TIME_ZONE || "America/New_York",
  senderName: process.env.COMPANY_NAME || "Agreements",
  replyTo: "",
  expiryDays: 14,
  dailyReminders: true,
  consent: [{ version: 1, text: DEFAULT_CONSENT, at: "2026-11-24T00:00:00.000Z" }],
  retentionYears: 7,
  attachFinalPdf: true,
  referencePrefix: "SA",
};

const KEY = "app:settings";

export async function appSettings(): Promise<AppSettings> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  const s = { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<AppSettings>) : {}) };
  // Settings saved before the brand guide kept the old placeholder blue: use the brand plum instead.
  if (!s.brandColor || s.brandColor.toLowerCase() === "#1f5f8b") s.brandColor = DEFAULT_SETTINGS.brandColor;
  if (!s.consent?.length) s.consent = DEFAULT_SETTINGS.consent;
  return s;
}

export async function writeSettings(patch: Partial<AppSettings>) {
  const next = { ...(await appSettings()), ...patch };
  await db.setting.upsert({ where: { key: KEY }, update: { value: JSON.stringify(next) }, create: { key: KEY, value: JSON.stringify(next) } });
  return next;
}

export const currentConsent = (s: AppSettings) => s.consent[s.consent.length - 1];

export function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
