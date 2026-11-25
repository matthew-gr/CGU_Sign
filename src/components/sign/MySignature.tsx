"use client";

// My account → My signature: create, preview, replace or delete the signature Sign offers when you sign a document
// (docs/esign.md, "Saved signature"). Same dialog as signing: type it, draw it, or upload a photo of it. It is never
// applied by itself: on each document you choose it and confirm.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { callAction } from "@/lib/call-action";
import { forgetMySignature, saveMySignature } from "@/lib/sign/actions";
const fmtDate = (d: Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
import { Adopt, type AdoptMeta, type Saved } from "./Adopt";

const HOW: Record<string, string> = { TYPED: "Typed", DRAWN: "Drawn", UPLOADED: "Uploaded" };

export function MySignature({ name, saved }: { name: string; saved: (Saved & { updatedAt: Date }) | null }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const save = (signature: string, initials: string, meta: AdoptMeta) => {
    setOpen(false);
    start(async () => {
      const r = await callAction(() => saveMySignature({ signature, initials, method: meta.method }));
      setMsg({ text: r.error ?? r.message ?? "Saved.", error: !!r.error });
      if (r.ok) router.refresh();
    });
  };
  const remove = () => {
    if (!window.confirm("Delete your saved signature and initials? You can create new ones any time.")) return;
    start(async () => {
      const r = await callAction(() => forgetMySignature());
      setMsg({ text: r.error ?? r.message ?? "Deleted.", error: !!r.error });
      if (r.ok) router.refresh();
    });
  };

  return (
    <div id="signature" className="scroll-mt-24 space-y-3">
      {saved ? (
        <>
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-gra-hair bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={saved.signature} alt="Your saved signature" className="h-14 max-w-[70%] object-contain" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {saved.initials && <img src={saved.initials} alt="Your saved initials" className="h-10 object-contain" />}
          </div>
          <p className="text-xs text-gra-muted">
            {HOW[saved.method] ?? "Saved"} · saved {fmtDate(saved.updatedAt)}
            {!saved.initials && " · no initials yet (typed from your name when a document needs them)"}
          </p>
        </>
      ) : (
        <p className="text-sm text-gra-ink-2">
          No saved signature yet. Create one and signing a document takes one click: type your name in a signature style, draw it with your finger, a pen or the mouse, or upload a photo of your signature on white paper.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={saved ? "btn-secondary" : "btn-primary"} disabled={pending} onClick={() => setOpen(true)}>
          {pending ? "Saving…" : saved ? "Replace signature" : "Create my signature"}
        </button>
        {saved && (
          <button type="button" className="text-xs font-medium text-rose-700 hover:underline disabled:opacity-60" disabled={pending} onClick={remove}>
            Delete
          </button>
        )}
      </div>
      <p className="text-xs text-gra-muted">Stored encrypted; only you can see or use it. It’s never applied by itself: on each document you choose it and confirm before signing.</p>
      {msg && <p className={`text-sm ${msg.error ? "text-rose-700" : "text-emerald-700"}`}>{msg.text}</p>}
      {open && <Adopt name={name} needsInitials mode="save" onAdopt={save} onCancel={() => setOpen(false)} />}
    </div>
  );
}
