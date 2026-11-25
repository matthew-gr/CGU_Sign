// All email goes through SendGrid's v3 API. Click and open tracking are off on every message: they carry sign-in and
// signing links, which SendGrid would otherwise rewrite. Outside production (EMAIL_DELIVERY != "on") nothing is sent;
// messages are kept in memory for tests and printed to the console in development.
import { appSettings } from "./settings";

export type Attachment = { filename: string; type: string; content: string; encoding?: "base64" };

export type OutgoingEmail = {
  to: { email: string; name: string };
  subject: string;
  body: string;
  link?: string;
  linkLabel?: string;
  attachments?: Attachment[];
  throwOnFailure?: boolean;
};

export const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

export const deliveryOn = () => process.env.EMAIL_DELIVERY === "on" && !!process.env.SENDGRID_API_KEY && !!process.env.EMAIL_FROM;

/** Messages "sent" while delivery is off (tests read them). */
export const outbox: (OutgoingEmail & { at: Date })[] = [];

export async function sendEmail(e: OutgoingEmail) {
  if (!deliveryOn()) {
    outbox.push({ ...e, at: new Date() });
    if (outbox.length > 500) outbox.shift();
    if (process.env.NODE_ENV !== "production" && process.env.QUIET_EMAIL !== "1")
      console.log(`[email] to ${e.to.email}: ${e.subject}\n${e.body}${e.link ? `\n${absolute(e.link)}` : ""}\n`);
    return;
  }
  await deliver(e).catch((err) => {
    console.error(`Email to ${e.to.email} not delivered: ${(err as Error).message}`);
    if (e.throwOnFailure) throw err;
  });
}

export const firstName = (name: string) => name.split(" ")[0];

const parseFrom = (from: string) => {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, ""), email: m[2] } : { email: from.trim() };
};
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const absolute = (link: string) => (/^https?:\/\//.test(link) ? link : `${appUrl()}${link.startsWith("/") ? "" : "/"}${link}`);

/** Client-branded HTML: logo, colour stripe, the message and one button. No Grow Rwanda branding. */
export async function brandedHtml(subject: string, body: string, link?: string, linkLabel = "Open") {
  const s = await appSettings();
  const color = /^#[0-9a-f]{6}$/i.test(s.brandColor) ? s.brandColor : "#1f5f8b";
  const paragraphs = esc(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  const button = link
    ? `<p style="margin:18px 0 4px"><a href="${esc(absolute(link))}" style="display:inline-block;background:${color};color:#ffffff;padding:12px 22px;border-radius:3px;text-decoration:none;font:700 14px Arial,sans-serif;letter-spacing:.5px;text-transform:uppercase">${esc(linkLabel)}</a></p>`
    : "";
  const logoSrc = s.logoUrl && /^https:\/\//.test(s.logoUrl) ? s.logoUrl : appUrl().startsWith("https://") ? `${appUrl()}/brand/logo.png` : "";
  const logo = logoSrc ? `<img src="${esc(logoSrc)}" alt="${esc(s.companyName)}" height="56" style="display:block;height:56px;margin-bottom:16px" />` : `<p style="font:700 16px Arial,sans-serif;margin:0 0 16px;color:${color}">${esc(s.companyName)}</p>`;
  return `<div style="background:#f9f9f9;padding:24px 12px">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;font-family:'Open Sans',Arial,sans-serif;font-size:15px;line-height:1.6;color:#333333">
<div style="height:4px;background:${color}"></div>
<div style="padding:24px 28px 26px">
${logo}
<h2 style="font:700 21px Georgia,'Times New Roman',serif;color:${color};margin:0 0 12px">${esc(subject)}</h2>
${paragraphs}${button}
</div>
<div style="padding:12px 28px;background:#f9f9f9;border-top:3px solid #1477bd;font-size:12px;color:#666666">${esc(s.companyName)}</div>
</div></div>`;
}

async function deliver(e: OutgoingEmail) {
  const s = await appSettings();
  const from = { ...parseFrom(process.env.EMAIL_FROM!), name: s.senderName || s.companyName };
  const text = `${e.body}${e.link ? `\n\n${e.linkLabel ?? "Open"}: ${absolute(e.link)}` : ""}`;
  const replyTo = s.replyTo || process.env.EMAIL_REPLY_TO;
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: e.to.email, name: e.to.name }] }],
      from,
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      subject: e.subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: await brandedHtml(e.subject, e.body, e.link, e.linkLabel) },
      ],
      ...(e.attachments?.length
        ? { attachments: e.attachments.map((a) => ({ filename: a.filename, type: a.type, disposition: "attachment", content: a.encoding === "base64" ? a.content : Buffer.from(a.content, "utf8").toString("base64") })) }
        : {}),
      tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
    }),
  });
  if (!res.ok) throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
