// The heading above a signing page: what's being signed, from whom, and their message. Server component.
import type { ReactNode } from "react";

export const maskEmail = (e: string) => {
  const [u, d] = e.split("@");
  return `${u.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`;
};

export function SignerShell({ title, from, message, company, children }: { title: string; from?: string; message?: string; company?: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-6 sm:px-4">
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo.png" alt={company ?? ""} className="mb-4 h-16 w-auto" />
        <p className="text-[18px] font-light tracking-wide text-brandblue uppercase">Electronic signature</p>
        <h1 className="text-3xl leading-tight font-bold">{title}</h1>
        {from && <p className="mt-1 text-sm text-gra-ink-2">Sent by {from}</p>}
      </div>
      {message && <p className="rounded-xl bg-gra-wash px-3.5 py-2.5 text-sm whitespace-pre-line text-gra-deep">{message}</p>}
      {children}
    </div>
  );
}

export function Stop({ text }: { text: string }) {
  return <div className="rounded-2xl bg-white p-5 text-sm text-gra-ink">{text}</div>;
}
