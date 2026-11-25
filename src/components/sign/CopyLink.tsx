"use client";

import { useState, useTransition } from "react";
import { copyLinkAction } from "@/lib/sign/actions";

/** "Copy link" for a signer whose turn it is: copies their signing link and shows it, to paste into your own email. */
export function CopyLink({ signerId }: { signerId: string }) {
  const [link, setLink] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();
  const copy = () =>
    start(async () => {
      const r = await copyLinkAction(signerId);
      if (!r.link) return setMsg(r.error ?? "Couldn't get the link.");
      setLink(r.link);
      try {
        await navigator.clipboard.writeText(r.link);
        setMsg("Copied. Paste it into your email.");
      } catch {
        setMsg("Select the link and copy it.");
      }
    });
  return (
    <div className="mt-1 space-y-1">
      <button type="button" className="text-xs font-medium text-gra-deep hover:underline" disabled={pending} onClick={copy}>
        {pending ? "Getting the link…" : "Copy signing link"}
      </button>
      {link && <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="input py-1 font-mono text-xs" aria-label="Signing link" />}
      {msg && <p className="text-xs text-gra-ink-2">{msg}</p>}
    </div>
  );
}
