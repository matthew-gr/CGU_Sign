"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { askForCode, enterCode } from "@/lib/login-actions";
import { callAction } from "@/lib/call-action";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loginId, setLoginId] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const ask = () =>
    start(async () => {
      setErr("");
      const r = await callAction(() => askForCode(email));
      if (r.error) return setErr(r.error);
      setLoginId(r.loginId ?? "");
      setMsg(r.message ?? "");
      setCode("");
    });
  const enter = () =>
    start(async () => {
      setErr("");
      const r = await callAction(() => enterCode(loginId, code, next));
      if (r.error) return setErr(r.error);
      router.push(r.href ?? "/");
      router.refresh();
    });

  return (
    <div className="mt-5 space-y-3">
      {!loginId ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
          className="space-y-3"
        >
          <label className="block">
            <span className="label">Work email</span>
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <button className="btn-primary w-full" disabled={pending || !email}>
            {pending ? "Sending..." : "Email me a code"}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            enter();
          }}
          className="space-y-3"
        >
          <p className="text-sm text-gra-ink-2">{msg}</p>
          <label className="block">
            <span className="label">6-digit code</span>
            <input className="input tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </label>
          <button className="btn-primary w-full" disabled={pending || code.replace(/\D/g, "").length !== 6}>
            {pending ? "Checking..." : "Sign in"}
          </button>
          <button type="button" className="text-sm text-gra-blue hover:underline" onClick={() => setLoginId("")} disabled={pending}>
            Use a different email, or send a new code
          </button>
        </form>
      )}
      {err && <p className="text-sm text-rose-700" role="alert">{err}</p>}
    </div>
  );
}
