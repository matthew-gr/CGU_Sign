"use client";

// The signer's page: the document with their fields highlighted, a "Next field" guide, adopt-once signature and
// initials, the consent box and typed legal name. Finish is enabled only when every required field is done and they
// have reached the last page. Decline asks for a reason.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { PdfPages } from "./PdfPages";
import { Adopt, type AdoptMeta, type Saved } from "./Adopt";
import { decline, finish, viewed, type SignerRef } from "@/lib/sign/actions";

type Field = { id: string; type: "SIGNATURE" | "INITIALS" | "DATE_SIGNED" | "NAME" | "TITLE" | "TEXT" | "CHECKBOX"; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string };

export type RoomProps = {
  refs: SignerRef;
  fileUrl: string;
  fields: Field[];
  name: string;
  consentText: string;
  today: string;
  /** Users signing as themselves: their saved signature, and whether they may save one. */
  saved?: Saved | null;
  canRemember?: boolean;
};

const LABEL: Record<Field["type"], string> = { SIGNATURE: "Sign", INITIALS: "Initial", DATE_SIGNED: "Date", NAME: "Name", TITLE: "Title", TEXT: "Text", CHECKBOX: "Tick" };

export function SigningRoom({ refs, fileUrl, fields, name, consentText, today, saved: initialSaved = null, canRemember = false }: RoomProps) {
  const [saved, setSaved] = useState(initialSaved);
  const [meta, setMeta] = useState<AdoptMeta | null>(null);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [sig, setSig] = useState("");
  const [ini, setIni] = useState("");
  const [adopting, setAdopting] = useState(false);
  const [typedName, setTypedName] = useState(name);
  const [consent, setConsent] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const pages = useRef(new Map<number, HTMLDivElement | null>());
  const needsInitials = fields.some((f) => f.type === "INITIALS");
  // One click when the saved signature covers everything this document needs; otherwise the dialog opens on it.
  const quickSaved = !!saved && (!needsInitials || !!saved.initials);
  const adopt = (s: string, i: string, m: AdoptMeta) => {
    setSig(s);
    setIni(i);
    setMeta(m);
    setAdopting(false);
  };

  useEffect(() => {
    void viewed(refs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isDone = useCallback(
    (f: Field) => {
      if (f.type === "SIGNATURE") return !!sig;
      if (f.type === "INITIALS") return !!ini;
      if (f.type === "DATE_SIGNED") return true;
      if (f.type === "NAME") return typedName.trim().length > 1;
      if (f.type === "CHECKBOX") return values[f.id] === "true" || !f.required;
      return (values[f.id] ?? "").trim().length > 0 || !f.required;
    },
    [sig, ini, typedName, values],
  );
  const ordered = useMemo(() => [...fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [fields]);
  const remaining = ordered.filter((f) => f.required && !isDone(f));
  const canFinish = !remaining.length && reachedEnd && consent && typedName.trim().length > 1 && !!sig;

  const goTo = (f: Field) => {
    const el = pages.current.get(f.page);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY + f.y * el.clientHeight - window.innerHeight / 3;
    window.scrollTo({ top, behavior: "smooth" });
    document.getElementById(`field-${f.id}`)?.focus({ preventScroll: true });
  };
  const next = () => {
    const target = remaining[0] ?? ordered.find((f) => !isDone(f));
    if (target) goTo(target);
    else window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  };

  const overlay = (page: number, css: { width: number; height: number }) => (
    <>
      {fields
        .filter((f) => f.page === page)
        .map((f) => {
          const ok = isDone(f);
          const style = { left: f.x * css.width, top: f.y * css.height, width: f.width * css.width, height: Math.max(f.height * css.height, f.type === "CHECKBOX" ? 22 : 24) };
          const ring = ok ? "border-emerald-600 bg-emerald-50/40" : f.required ? "border-amber-500 bg-amber-100/70 animate-pulse" : "border-sky-500 bg-sky-50/60";
          if (f.type === "SIGNATURE" || f.type === "INITIALS") {
            const img = f.type === "SIGNATURE" ? sig : ini;
            return (
              <button id={`field-${f.id}`} key={f.id} type="button" onClick={() => setAdopting(true)} className={`absolute flex items-center justify-center rounded border-2 text-xs font-semibold text-gra-deep ${ring}`} style={style}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {img ? <img src={img} alt={f.type === "SIGNATURE" ? "Your signature" : "Your initials"} className="h-full max-w-full object-contain" /> : LABEL[f.type]}
              </button>
            );
          }
          if (f.type === "DATE_SIGNED" || f.type === "NAME")
            return (
              <div id={`field-${f.id}`} tabIndex={-1} key={f.id} className={`absolute flex items-center overflow-hidden rounded border px-1 text-[11px] text-[#13215a] ${ok ? "border-emerald-600/50" : "border-amber-500 bg-amber-100/70"}`} style={style}>
                {f.type === "DATE_SIGNED" ? today : typedName || "Your name"}
              </div>
            );
          if (f.type === "CHECKBOX")
            return (
              <label key={f.id} className={`absolute flex items-center gap-1 rounded border-2 px-0.5 ${ring}`} style={{ ...style, width: "auto", minWidth: style.width }}>
                <input id={`field-${f.id}`} type="checkbox" className="h-4 w-4" checked={values[f.id] === "true"} onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.checked ? "true" : "false" }))} aria-label={f.label || "Checkbox"} />
              </label>
            );
          return (
            <input
              id={`field-${f.id}`}
              key={f.id}
              className={`absolute rounded border-2 px-1 text-[11px] text-[#13215a] ${ring}`}
              style={style}
              placeholder={f.label || LABEL[f.type]}
              aria-label={f.label || LABEL[f.type]}
              value={values[f.id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            />
          );
        })}
    </>
  );

  if (done)
    return (
      <div className="space-y-3 rounded-2xl bg-white p-6 text-center">
        <p className="text-3xl">✓</p>
        <p className="text-lg font-semibold text-gra-deep">{done}</p>
        <p className="text-sm text-gra-ink-2">You&apos;ll get an email with the signed copy once everyone has signed. You can close this page.</p>
      </div>
    );

  return (
    <div className="space-y-4 pb-40">
      <div className="sticky top-[var(--header-h,0px)] z-30 -mx-2 flex items-center justify-between gap-2 rounded-b-xl bg-white/95 px-3 py-2 shadow-sm backdrop-blur">
        <span className="text-xs text-gra-ink-2">
          {remaining.length ? `${remaining.length} required field${remaining.length === 1 ? "" : "s"} left` : reachedEnd ? "All fields done" : "Scroll to the last page"}
        </span>
        <button type="button" className="btn-primary text-sm" onClick={next}>
          {remaining.length ? "Next field ↓" : "To the end ↓"}
        </button>
      </div>
      <PdfPages url={fileUrl} overlay={overlay} onLastPageSeen={() => setReachedEnd(true)} pageRef={(n, el) => void pages.current.set(n, el)} />

      <section className="space-y-3 rounded-2xl bg-white p-4 sm:p-5">
        <h2 className="font-semibold text-gra-deep">Finish signing</h2>
        <label className="block space-y-1">
          <span className="label">Your full legal name</span>
          <input className="input" value={typedName} onChange={(e) => setTypedName(e.target.value)} autoComplete="name" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {sig ? <img src={sig} alt="Your adopted signature" className="h-12 rounded border border-gra-hair bg-white px-2" /> : null}
          {!sig && quickSaved && saved && (
            <button type="button" className="btn-primary flex items-center gap-2 text-sm" onClick={() => adopt(saved.signature, needsInitials ? saved.initials : "", { method: saved.method, remember: canRemember })}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={saved.signature} alt="" className="h-6 rounded bg-white px-1" />
              Use my saved signature
            </button>
          )}
          <button type="button" className="btn-secondary text-sm" onClick={() => setAdopting(true)}>
            {sig ? "Change signature" : quickSaved ? "Use a different one" : "Adopt your signature"}
          </button>
        </div>
        <details className="rounded-md border border-gra-hair bg-gra-page p-3 text-sm" open>
          <summary className="cursor-pointer font-medium">Consent to electronic records and signatures</summary>
          <p className="mt-2 whitespace-pre-line text-gra-ink-2">{consentText}</p>
        </details>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I have read the disclosure above and agree to use electronic records and signatures for this agreement.</span>
        </label>
        {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={!canFinish || pending}
            onClick={() =>
              start(async () => {
                setError("");
                const r = await finish(refs, { values, signature: sig, initials: ini || undefined, typedName, consent, reachedEnd, remember: canRemember && !!meta?.remember, method: meta?.method });
                if (r.ok) {
                  setDone(r.message ?? "Signed.");
                  router.refresh();
                } else setError(r.error ?? "Couldn't finish.");
              })
            }
          >
            {pending ? "Signing…" : "Finish"}
          </button>
          {!canFinish && (
            <span className="text-xs text-gra-ink-2">
              {!sig ? "Adopt your signature. " : ""}
              {remaining.length ? "Complete the highlighted fields. " : ""}
              {!reachedEnd ? "Scroll to the last page. " : ""}
              {!consent ? "Tick the box to agree." : ""}
            </span>
          )}
          <button type="button" className="ml-auto text-sm text-rose-700 underline" onClick={() => setDeclining((d) => !d)}>
            Decline to sign
          </button>
        </div>
        {declining && (
          <div className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 p-3">
            <label className="block space-y-1 text-sm">
              <span>Why are you declining? The sender will see this, and signing will stop.</span>
              <textarea className="input h-20" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button
              type="button"
              className="btn-secondary text-sm text-rose-800"
              disabled={pending || reason.trim().length < 3}
              onClick={() =>
                start(async () => {
                  const r = await decline(refs, reason);
                  if (r.ok) setDone(r.message ?? "Declined.");
                  else setError(r.error ?? "Couldn't decline.");
                })
              }
            >
              Decline
            </button>
          </div>
        )}
      </section>
      {adopting && (
        <Adopt
          name={typedName || name}
          needsInitials={needsInitials}
          onCancel={() => setAdopting(false)}
          onAdopt={adopt}
          saved={saved}
          canRemember={canRemember}
          onForget={() => setSaved(null)}
        />
      )}
    </div>
  );
}
