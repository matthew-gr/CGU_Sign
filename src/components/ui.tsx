import type { ReactNode } from "react";

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-gra-hair bg-white ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-gra-hair px-5 py-3">
          <h2 className="text-base font-semibold text-gra-ink">{title}</h2>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[26px] leading-tight font-semibold text-gra-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gra-ink-2">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  SENT: "bg-sky-50 text-sky-800",
  VIEWED: "bg-sky-50 text-sky-800",
  PARTIALLY_SIGNED: "bg-amber-50 text-amber-800",
  COMPLETED: "bg-emerald-50 text-emerald-800",
  DECLINED: "bg-rose-50 text-rose-800",
  VOIDED: "bg-gray-100 text-gray-600",
  EXPIRED: "bg-gray-100 text-gray-600",
};
const STATUS_TEXT: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Out for signature",
  VIEWED: "Viewed",
  PARTIALLY_SIGNED: "Partly signed",
  COMPLETED: "Completed",
  DECLINED: "Declined",
  VOIDED: "Voided",
  EXPIRED: "Expired",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_COLOR[status] ?? "bg-gray-100"}`}>{STATUS_TEXT[status] ?? status}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-gray-500 italic">{children}</p>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "success"; children: ReactNode }) {
  const cls = {
    info: "bg-gra-wash text-gra-deep border-transparent",
    warn: "bg-amber-50 text-amber-900 border-amber-200",
    error: "bg-rose-50 text-rose-900 border-rose-200",
    success: "bg-emerald-50 text-emerald-900 border-emerald-200",
  }[tone];
  return <div className={`rounded-md border px-3.5 py-2.5 text-sm whitespace-pre-line ${cls}`}>{children}</div>;
}
