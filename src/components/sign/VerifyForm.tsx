"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { verifyUpload } from "@/lib/sign/actions";
import { callAction } from "@/lib/call-action";

type Verdict = NonNullable<Awaited<ReturnType<typeof verifyUpload>>["verdict"]>;

const when = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "");

/** Upload any PDF: it is hashed and checked against the final PDFs of completed agreements on record. */
export function VerifyForm() {
  const [pending, start] = useTransition();
  const [v, setV] = useState<Verdict | null>(null);
  const [error, setError] = useState("");
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          start(async () => {
            setError("");
            setV(null);
            const r = await callAction(() => verifyUpload(fd));
            if (r.verdict) setV(r.verdict);
            else setError(r.error ?? "Couldn't check that file.");
          });
        }}
      >
        <input type="file" name="file" accept="application/pdf,.pdf" required className="input max-w-md py-1.5" aria-label="PDF to verify" />
        <button className="btn-primary" disabled={pending}>
          {pending ? "Checking…" : "Verify"}
        </button>
      </form>
      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900">{error}</p>}
      {v && (
        <div className={`space-y-2 rounded-xl border p-4 text-sm ${v.match === "FINAL" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900"}`}>
          {v.match === "FINAL" ? (
            <>
              <p className="text-base font-semibold">✓ Genuine: this is exactly the signed PDF of a completed agreement.</p>
              {v.envelope?.visible ? (
                <p>
                  <Link href={`/envelopes/${v.envelope.id}`} className="underline">
                    {v.envelope.title}
                  </Link>
                  , completed {when(v.envelope.completedAt)}. Signed by {v.envelope.signers.join(", ")}.
                </p>
              ) : (
                <p>{v.envelope?.completedAt ? `Completed ${when(v.envelope.completedAt)}. ` : ""}You don&apos;t have access to it, so its details aren&apos;t shown.</p>
              )}
            </>
          ) : v.match === "INTERMEDIATE" ? (
            <p className="text-base font-semibold">This matches a version from before signing was complete. It isn&apos;t the final signed document.</p>
          ) : (
            <p className="text-base font-semibold">✕ No match. This file isn&apos;t a completed agreement on record, or it has been changed (even one character changes the fingerprint).</p>
          )}
          {v.certificate.present && <p>{v.certificate.valid ? `Digital certificate (${v.certificate.signer}): intact.` : `Digital certificate${v.certificate.signer ? ` (${v.certificate.signer})` : ""}: ${v.certificate.reason}`}</p>}
          <p className="text-xs opacity-80">
            SHA-256: <span className="font-mono break-all">{v.hash}</span>
          </p>
        </div>
      )}
    </div>
  );
}
