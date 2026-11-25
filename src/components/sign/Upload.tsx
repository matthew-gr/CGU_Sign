"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { uploadEnvelope } from "@/lib/sign/actions";
import { callAction } from "@/lib/call-action";

/** Upload a ready PDF or a photo/scan (JPG, PNG; up to 25 MB) to start a draft document, then prepare it. */
export function Upload() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          setError("");
          const r = await callAction(() => uploadEnvelope(fd));
          if (r.ok && r.id) router.push(`/envelopes/${r.id}`);
          else setError(r.error ?? "Upload failed.");
        });
      }}
    >
      <label className="block space-y-1">
        <span className="label">PDF, JPG or PNG, up to 25 MB (a photo or scan becomes a one-page PDF)</span>
        <input name="file" type="file" accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png" required className="input py-1.5" />
      </label>
      <label className="block space-y-1">
        <span className="label">Title (optional: the file name otherwise)</span>
        <input name="title" className="input" placeholder="e.g. Change order, Smith kitchen" />
      </label>
      <p className="text-xs text-gra-ink-2">
        Next you add signers and drag fields (signature, date, initials, name, text, checkbox) onto the pages. Tip: if you make the PDF yourself, put anchors in it, like <code>{"{{sig:1}}"}</code>, <code>{"{{date:2}}"}</code>, <code>{"{{initials:1}}"}</code>, <code>{"{{name:2}}"}</code>, <code>{"{{title:2}}"}</code>,{" "}
        <code>{"{{text:1:Label}}"}</code> or <code>{"{{check:1:Label}}"}</code> (the number is the signer&apos;s position), and fields are placed for you.
      </p>
      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900">{error}</p>}
      <button className="btn-primary" disabled={pending}>
        {pending ? "Uploading…" : "Upload and continue"}
      </button>
    </form>
  );
}
