"use client";

// A cc viewer downloads the final PDF: email a code, then submit it with the download form (the route checks it).
import { useState, useTransition } from "react";
import { sendCode } from "@/lib/sign/actions";

export function ViewerDownload({ token, maskedEmail }: { token: string; maskedEmail: string }) {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-4 rounded-lg border border-gra-hair bg-white p-5">
      <h2 className="font-semibold">Confirm it&apos;s you</h2>
      <p className="text-sm text-gra-ink-2">
        We&apos;ll email a 6-digit code to <b>{maskedEmail}</b>. Then download the signed PDF with it.
      </p>
      {!sent ? (
        <button
          type="button"
          className="btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await sendCode(token, "DOWNLOAD");
              setMsg(r.ok ? { ok: true, text: r.message ?? "Code sent." } : { ok: false, text: r.error ?? "Couldn't send the code." });
              if (r.ok) setSent(true);
            })
          }
        >
          {pending ? "Sending..." : "Email me a code"}
        </button>
      ) : (
        <form method="post" action={`/d/${token}/download`} className="flex flex-wrap gap-2">
          <input
            name="code"
            className="input max-w-[10rem] text-center text-lg tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            aria-label="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          <button type="submit" className="btn-primary" disabled={code.length !== 6}>
            Download the signed PDF
          </button>
        </form>
      )}
      {msg && <p className={`rounded-md px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-900"}`}>{msg.text}</p>}
    </div>
  );
}
