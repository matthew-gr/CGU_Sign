import { STATUS_LABEL } from "@/lib/sign/core";

const TONE: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  SENT: "bg-sky-50 text-sky-800",
  PARTIALLY_SIGNED: "bg-amber-50 text-amber-900",
  COMPLETED: "bg-emerald-50 text-emerald-800",
  DECLINED: "bg-rose-50 text-rose-800",
  VOIDED: "bg-gray-100 text-gray-500",
  EXPIRED: "bg-gray-100 text-gray-500",
};

export function EnvelopeStatus({ status }: { status: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[status] ?? "bg-gray-100"}`}>{STATUS_LABEL[status] ?? status}</span>;
}
