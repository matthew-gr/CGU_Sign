"use client";

// External signers confirm it's them with a 6-digit code emailed to them, before they see the document (and again
// to download the final copy). Expired or used links can ask for a new link, which goes to their own address only.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkCode, newLink, sendCode } from "@/lib/sign/actions";

export function CodeGate({ token, maskedEmail, purpose = "SIGN" }: { token: string; maskedEmail: string; purpose?: "SIGN" | "DOWNLOAD" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-4 rounded-2xl bg-white p-5">
      <h2 className="font-semibold text-gra-deep">Confirm it&apos;s you</h2>
      <p className="text-sm text-gra-ink-2">
        We&apos;ll email a 6-digit code to <b>{maskedEmail}</b>. It works for 10 minutes.
      </p>
      {!sent ? (
        <button
          type="button"
          className="btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await sendCode(token, purpose);
              setMsg(r.ok ? { ok: true, text: r.message ?? "Code sent." } : { ok: false, text: r.error ?? "Couldn't send the code." });
              if (r.ok) setSent(true);
            })
          }
        >
          {pending ? "Sending…" : "Email me a code"}
        </button>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await checkCode(token, code, purpose);
              if (r.ok) router.refresh();
              else setMsg({ ok: false, text: r.error ?? "That didn't work." });
            });
          }}
        >
          <input
            className="input max-w-[10rem] text-center text-lg tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="\d{6}"
            aria-label="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          <button type="submit" className="btn-primary" disabled={pending || code.length !== 6}>
            {pending ? "Checking…" : "Continue"}
          </button>
          <button type="button" className="text-sm underline" disabled={pending} onClick={() => start(async () => setMsg(await sendCode(token, purpose).then((r) => (r.ok ? { ok: true, text: "A new code is on its way." } : { ok: false, text: r.error ?? "" }))))}>
            Send a new code
          </button>
        </form>
      )}
      {msg && <p className={`rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-900"}`}>{msg.text}</p>}
    </div>
  );
}

export function NewLink({ token, why }: { token: string; why: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-3 rounded-2xl bg-white p-5">
      <p className="text-sm">{why}</p>
      <button
        type="button"
        className="btn-primary"
        disabled={pending || !!msg?.ok}
        onClick={() => start(async () => setMsg(await newLink(token).then((r) => (r.ok ? { ok: true, text: r.message ?? "Sent." } : { ok: false, text: r.error ?? "Couldn't send." }))))}
      >
        Email me a new link
      </button>
      {msg && <p className={`rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-900"}`}>{msg.text}</p>}
    </div>
  );
}
