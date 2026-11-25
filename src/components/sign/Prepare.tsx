"use client";

// Preparing a draft document: signers → fields (drag from the palette or tap a type then tap the page; move and resize
// on the page; or a saved layout, or the PDF's anchors) → options → send. Every save goes through a server action
// that re-checks access and validates geometry.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type PointerEvent as RPointerEvent } from "react";
import { PdfPages, SIGNER_COLORS, type PageSize } from "./PdfPages";
import { applyTemplateAction, placeFromAnchors, saveAsTemplate, saveFields, saveOptions, saveSigners, sendNow, type SignResult } from "@/lib/sign/actions";

export type FieldType = "SIGNATURE" | "INITIALS" | "DATE_SIGNED" | "NAME" | "TITLE" | "TEXT" | "CHECKBOX";
const TYPES: [FieldType, string][] = [
  ["SIGNATURE", "Signature"],
  ["INITIALS", "Initials"],
  ["DATE_SIGNED", "Date signed"],
  ["NAME", "Name"],
  ["TITLE", "Title"],
  ["TEXT", "Text"],
  ["CHECKBOX", "Checkbox"],
];
const SIZE: Record<FieldType, [number, number]> = { SIGNATURE: [170, 42], INITIALS: [64, 34], DATE_SIGNED: [100, 18], NAME: [170, 18], TITLE: [170, 18], TEXT: [170, 18], CHECKBOX: [14, 14] };
const LABEL = Object.fromEntries(TYPES) as Record<FieldType, string>;

type Signer = { id?: string; name: string; email: string; company: string; role: string };
type Viewer = { name: string; email: string };
type Field = { key: string; signerId: string; type: FieldType; page: number; x: number; y: number; width: number; height: number; required: boolean; label: string; placedBy: string };

export type PrepareProps = {
  env: { id: string; title: string; message: string; expires: string; viewers: Viewer[]; confidential: boolean; signingOrder: "SEQUENTIAL" | "PARALLEL"; pageCount: number };
  signers: (Signer & { id: string; order: number })[];
  fields: Omit<Field, "key">[];
  templates: { id: string; name: string; signerCount: number }[];
  anchors: { count: number; signers: number[] };
};

let seq = 0;
const key = () => `f${++seq}`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const BLANK: Signer = { name: "", email: "", company: "", role: "" };

export function Prepare({ env, signers: initialSigners, fields: initialFields, templates, anchors }: PrepareProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<SignResult | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(initialSigners.length ? (initialFields.length ? 3 : 2) : 1);

  // ----- signers -----
  const [signers, setSigners] = useState<Signer[]>(initialSigners.length ? initialSigners.map(({ id, name, email, company, role }) => ({ id, name, email, company, role })) : [BLANK]);
  const [order, setOrder] = useState(env.signingOrder);
  const editSigner = (i: number, patch: Partial<Signer>) => setSigners((ss) => ss.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  // ----- fields -----
  const [fields, setFields] = useState<Field[]>(initialFields.map((f) => ({ ...f, key: key() })));
  const [picked, setActive] = useState(initialSigners[0]?.id ?? "");
  // Signers saved after the page loaded (step 1) arrive as new props: default to the first.
  const active = initialSigners.some((s) => s.id === picked) ? picked : (initialSigners[0]?.id ?? "");
  const [armed, setArmed] = useState<FieldType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [dirty, setDirty] = useState(false);
  // Fields placed on the server (layout, anchors, a save) replace the local copy unless there are unsaved edits.
  const serverFields = JSON.stringify(initialFields);
  useEffect(() => {
    if (!dirty) setFields(initialFields.map((f) => ({ ...f, key: key() })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverFields]);
  const colorOf = useMemo(() => new Map(initialSigners.map((s, i) => [s.id, SIGNER_COLORS[i % SIGNER_COLORS.length]])), [initialSigners]);

  // ----- options -----
  const [title, setTitle] = useState(env.title);
  const [message, setMessage] = useState(env.message);
  const [expires, setExpires] = useState(env.expires);
  const [viewers, setViewers] = useState<Viewer[]>(env.viewers);
  const [confidential, setConfidential] = useState(env.confidential);
  const [tplName, setTplName] = useState("");
  const editViewer = (i: number, patch: Partial<Viewer>) => setViewers((vs) => vs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const options = () => ({ title, message, expires, confidential, viewers: viewers.map((v) => ({ name: v.name.trim(), email: v.email.trim() })).filter((v) => v.email) });

  const act = (fn: () => Promise<SignResult>, then?: (r: SignResult) => void) =>
    start(async () => {
      const r = await fn();
      setMsg(r);
      if (r.ok) {
        then?.(r);
        router.refresh();
      }
    });

  const fieldPayload = () => fields.map(({ signerId, type, page, x, y, width, height, required, label, placedBy }) => ({ signerId, type, page, x, y, width, height, required, label, placedBy }));

  // Place a field of `type` for the active signer with its top-left at (fx, fy) (fractions of the page).
  const place = (type: FieldType, page: number, fx: number, fy: number) => {
    const size = sizes[page - 1];
    if (!size || !active) return;
    const w = SIZE[type][0] / size.width;
    const h = SIZE[type][1] / size.height;
    const f: Field = { key: key(), signerId: active, type, page, x: r6(clamp(fx, 0, 1 - w)), y: r6(clamp(fy, 0, 1 - h)), width: r6(w), height: r6(h), required: true, label: type === "TEXT" ? "Text" : "", placedBy: "DRAG" };
    setFields((fs) => [...fs, f]);
    setSelected(f.key);
    setDirty(true);
  };

  // Moving and resizing with pointer events (mouse, pen and touch).
  const drag = useRef<{ key: string; mode: "move" | "resize"; startX: number; startY: number; orig: Field; css: { width: number; height: number } } | null>(null);
  const onPointerDown = (e: RPointerEvent, f: Field, mode: "move" | "resize", css: { width: number; height: number }) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { key: f.key, mode, startX: e.clientX, startY: e.clientY, orig: f, css };
    setSelected(f.key);
  };
  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.css.width;
    const dy = (e.clientY - d.startY) / d.css.height;
    setFields((fs) =>
      fs.map((f) => {
        if (f.key !== d.key) return f;
        if (d.mode === "move") return { ...f, x: r6(clamp(d.orig.x + dx, 0, 1 - f.width)), y: r6(clamp(d.orig.y + dy, 0, 1 - f.height)) };
        return { ...f, width: r6(clamp(d.orig.width + dx, 0.02, 1 - f.x)), height: r6(clamp(d.orig.height + dy, 0.012, 1 - f.y)) };
      }),
    );
    setDirty(true);
  };
  const onPointerUp = () => (drag.current = null);

  const overlay = useCallback(
    (page: number, css: { width: number; height: number }) => (
      <div
        className={`absolute inset-0 ${armed ? "cursor-crosshair" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const type = e.dataTransfer.getData("text/x-sign-field") as FieldType;
          if (!type || !(type in SIZE)) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          place(type, page, (e.clientX - r.left) / css.width, (e.clientY - r.top) / css.height);
        }}
        onClick={(e) => {
          if (!armed) return setSelected(null);
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          place(armed, page, (e.clientX - r.left) / css.width, (e.clientY - r.top) / css.height);
          setArmed(null);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {fields
          .filter((f) => f.page === page)
          .map((f) => {
            const color = colorOf.get(f.signerId) ?? "#64748b";
            const sel = selected === f.key;
            return (
              <div
                key={f.key}
                onPointerDown={(e) => onPointerDown(e, f, "move", css)}
                onClick={(e) => e.stopPropagation()}
                className="absolute flex touch-none items-center justify-center overflow-hidden rounded-sm text-[10px] font-medium select-none"
                style={{ left: f.x * css.width, top: f.y * css.height, width: f.width * css.width, height: f.height * css.height, background: `${color}26`, border: `${sel ? 2 : 1}px solid ${color}`, color, cursor: "move" }}
                title={`${LABEL[f.type]} · ${initialSigners.find((s) => s.id === f.signerId)?.name ?? ""}`}
              >
                <span className="truncate px-1">{f.type === "CHECKBOX" ? "☐" : f.label && (f.type === "TEXT" || f.type === "TITLE") ? f.label : LABEL[f.type]}</span>
                {sel && (
                  <>
                    <button
                      type="button"
                      aria-label="Remove field"
                      className="absolute -top-0 right-0 bg-white/90 px-1 leading-none text-rose-600"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFields((fs) => fs.filter((x) => x.key !== f.key));
                        setSelected(null);
                        setDirty(true);
                      }}
                    >
                      ×
                    </button>
                    <span onPointerDown={(e) => onPointerDown(e, f, "resize", css)} className="absolute right-0 bottom-0 h-2.5 w-2.5 cursor-se-resize" style={{ background: color }} />
                  </>
                )}
              </div>
            );
          })}
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, selected, armed, active, sizes, initialSigners, colorOf],
  );

  const sel = fields.find((f) => f.key === selected);
  const missingSig = initialSigners.filter((s) => !fields.some((f) => f.signerId === s.id && f.type === "SIGNATURE"));

  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap gap-2 text-sm">
        {(["Signers", "Fields", "Options and send"] as const).map((l, i) => (
          <li key={l}>
            <button
              type="button"
              disabled={(i >= 1 && !initialSigners.length) || pending}
              onClick={() => setStep((i + 1) as 1 | 2 | 3)}
              className={`rounded-full px-3 py-1 ${step === i + 1 ? "bg-gra-deep text-white" : "bg-white text-gra-ink-2 disabled:opacity-40"}`}
            >
              {i + 1}. {l}
            </button>
          </li>
        ))}
      </ol>
      {msg?.error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900">{msg.error}</p>}
      {msg?.ok && msg.message && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{msg.message}</p>}

      {step === 1 && (
        <section className="space-y-3 rounded-2xl bg-white p-5">
          <h2 className="font-semibold text-gra-deep">Who signs</h2>
          <p className="text-xs text-gra-ink-2">Each signer gets an email with their own link and confirms who they are with a 6-digit code sent to that address. The role is an optional label shown to signers, like &quot;Client&quot; or &quot;Contractor&quot;.</p>
          {signers.map((s, i) => (
            <div key={i} className="grid gap-2 rounded-xl border border-gra-hair p-3 sm:grid-cols-[2rem_1fr_1fr_1fr_1fr_auto]">
              <span className="self-center text-sm font-semibold" style={{ color: SIGNER_COLORS[i % SIGNER_COLORS.length] }}>
                {i + 1}
              </span>
              <input aria-label={`Signer ${i + 1} name`} className="input" placeholder="Full name" value={s.name} onChange={(e) => editSigner(i, { name: e.target.value })} />
              <input aria-label={`Signer ${i + 1} email`} className="input" type="email" placeholder="Email" value={s.email} onChange={(e) => editSigner(i, { email: e.target.value })} />
              <input aria-label={`Signer ${i + 1} company`} className="input" placeholder="Company (optional)" value={s.company} onChange={(e) => editSigner(i, { company: e.target.value })} />
              <input aria-label={`Signer ${i + 1} role`} className="input" placeholder="Role (optional)" value={s.role} onChange={(e) => editSigner(i, { role: e.target.value })} />
              <div className="flex gap-1">
                <button type="button" className="btn-secondary px-2 text-xs" disabled={i === 0} onClick={() => setSigners((ss) => ss.map((x, j) => (j === i - 1 ? ss[i] : j === i ? ss[i - 1] : x)))} aria-label="Move up">
                  ↑
                </button>
                <button type="button" className="btn-secondary px-2 text-xs text-rose-700" onClick={() => setSigners((ss) => ss.filter((_, j) => j !== i))} aria-label="Remove signer">
                  ×
                </button>
              </div>
            </div>
          ))}
          {signers.length < 10 && (
            <button type="button" className="btn-secondary text-sm" onClick={() => setSigners((ss) => [...ss, { ...BLANK }])}>
              + Add a signer
            </button>
          )}
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={order === "PARALLEL"} onChange={() => setOrder("PARALLEL")} /> Everyone at once (any order)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={order === "SEQUENTIAL"} onChange={() => setOrder("SEQUENTIAL")} /> One after another, in this order
            </label>
          </fieldset>
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() =>
              act(
                () => saveSigners(env.id, signers.map((s) => ({ id: s.id, name: s.name, email: s.email, company: s.company, role: s.role })), order),
                () => setStep(2),
              )
            }
          >
            Save signers and place fields →
          </button>
        </section>
      )}

      {step === 2 && (
        <div className="grid gap-5 lg:grid-cols-[17rem_1fr]">
          {/* Sticks under the site header (--header-h) and scrolls on its own when taller than the screen. */}
          <aside className="space-y-4 lg:sticky lg:top-[calc(var(--header-h,7rem)+1rem)] lg:max-h-[calc(100dvh-var(--header-h,7rem)-2rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:pb-2">
            <section className="space-y-2 rounded-2xl bg-white p-4">
              <h3 className="text-sm font-semibold text-gra-deep">Fields for</h3>
              <div className="flex flex-wrap gap-1.5">
                {initialSigners.map((s) => (
                  <button key={s.id} type="button" onClick={() => setActive(s.id)} className="rounded-full border px-2.5 py-1 text-xs" style={{ borderColor: colorOf.get(s.id), background: active === s.id ? colorOf.get(s.id) : "white", color: active === s.id ? "white" : colorOf.get(s.id) }}>
                    {s.order ?? ""} {s.name}
                    {s.role ? ` (${s.role})` : ""}
                  </button>
                ))}
              </div>
              <p className="pt-1 text-xs text-gra-ink-2">Drag a field onto the page, or tap it and then tap the page.</p>
              <div className="grid grid-cols-2 gap-1.5">
                {TYPES.map(([t, l]) => (
                  <button
                    key={t}
                    type="button"
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/x-sign-field", t)}
                    onClick={() => setArmed(armed === t ? null : t)}
                    className={`rounded-lg border px-2 py-1.5 text-left text-xs ${armed === t ? "border-gra-deep bg-gra-wash" : "border-gra-hair bg-white"}`}
                    style={{ borderLeft: `4px solid ${colorOf.get(active) ?? "#ccc"}` }}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </section>
            {sel && (
              <section className="space-y-2 rounded-2xl bg-white p-4 text-sm">
                <h3 className="font-semibold text-gra-deep">{LABEL[sel.type]}</h3>
                <select className="input" value={sel.signerId} onChange={(e) => (setFields((fs) => fs.map((f) => (f.key === sel.key ? { ...f, signerId: e.target.value } : f))), setDirty(true))} aria-label="Signer for this field">
                  {initialSigners.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {(sel.type === "TEXT" || sel.type === "CHECKBOX" || sel.type === "TITLE") && (
                  <>
                    <input className="input" placeholder="Label shown to the signer" value={sel.label} onChange={(e) => (setFields((fs) => fs.map((f) => (f.key === sel.key ? { ...f, label: e.target.value } : f))), setDirty(true))} />
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={sel.required} onChange={(e) => (setFields((fs) => fs.map((f) => (f.key === sel.key ? { ...f, required: e.target.checked } : f))), setDirty(true))} /> Required
                    </label>
                  </>
                )}
              </section>
            )}
            <section className="space-y-2 rounded-2xl bg-white p-4 text-sm">
              {templates.length > 0 && (
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-gra-deep">Apply a saved layout</span>
                  <select className="input" defaultValue="" onChange={(e) => e.target.value && act(() => applyTemplateAction(env.id, e.target.value), () => setDirty(false))} aria-label="Saved layout">
                    <option value="">{templates.length} for {env.pageCount}-page documents…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.signerCount} signer{t.signerCount === 1 ? "" : "s"})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {anchors.count > 0 && (
                <button type="button" className="btn-secondary w-full text-xs" disabled={pending} onClick={() => act(() => placeFromAnchors(env.id), () => setDirty(false))}>
                  Place {anchors.count} field{anchors.count === 1 ? "" : "s"} from the PDF&apos;s anchors
                </button>
              )}
              <div className="flex gap-1.5">
                <input className="input text-xs" placeholder="Layout name, e.g. Services agreement v3" value={tplName} onChange={(e) => setTplName(e.target.value)} aria-label="Layout name" />
                <button type="button" className="btn-secondary shrink-0 text-xs" disabled={pending || !tplName.trim() || dirty || !fields.length} title={dirty ? "Save the fields first" : ""} onClick={() => act(() => saveAsTemplate(env.id, tplName.trim()), () => setTplName(""))}>
                  Save layout
                </button>
              </div>
            </section>
            <div className="flex flex-col gap-2">
              <button type="button" className="btn-primary" disabled={pending} onClick={() => act(() => saveFields(env.id, fieldPayload()), () => setDirty(false))}>
                {dirty ? "Save fields" : "Fields saved"}
              </button>
              <button type="button" className="btn-secondary" disabled={pending || dirty || missingSig.length > 0} onClick={() => setStep(3)} title={missingSig.length ? `${missingSig.map((s) => s.name).join(", ")} needs a signature field` : ""}>
                Next: options →
              </button>
              {missingSig.length > 0 && <p className="text-xs text-amber-800">Still needs a signature field: {missingSig.map((s) => s.name).join(", ")}</p>}
            </div>
          </aside>
          <div className="min-w-0 rounded-2xl bg-gra-page/60 p-2 sm:p-4">
            <PdfPages url={`/api/sign/file/${env.id}?which=current`} onPages={setSizes} overlay={overlay} />
          </div>
        </div>
      )}

      {step === 3 && (
        <section className="space-y-4 rounded-2xl bg-white p-5">
          <label className="block space-y-1">
            <span className="label">Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="label">Message to signers (optional)</span>
            <textarea className="input h-24" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Shown in the email. Don't put confidential terms here." />
          </label>
          <label className="block max-w-xs space-y-1">
            <span className="label">Sign by</span>
            <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
          <div className="space-y-2">
            <span className="label">Copy to (cc: they get the signed copy, they don&apos;t sign)</span>
            {viewers.map((v, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input aria-label={`cc ${i + 1} name`} className="input" placeholder="Name" value={v.name} onChange={(e) => editViewer(i, { name: e.target.value })} />
                <input aria-label={`cc ${i + 1} email`} className="input" type="email" placeholder="Email" value={v.email} onChange={(e) => editViewer(i, { email: e.target.value })} />
                <button type="button" className="btn-secondary px-2 text-xs text-rose-700" onClick={() => setViewers((vs) => vs.filter((_, j) => j !== i))} aria-label="Remove cc">
                  ×
                </button>
              </div>
            ))}
            {viewers.length < 10 && (
              <button type="button" className="btn-secondary text-sm" onClick={() => setViewers((vs) => [...vs, { name: "", email: "" }])}>
                + Add someone to copy
              </button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} /> Confidential: don&apos;t attach the signed PDF to the completion email (a download link only)
          </label>
          <div className="rounded-xl bg-gra-wash p-3 text-sm">
            <b>Ready to send:</b> {initialSigners.length} signer{initialSigners.length === 1 ? "" : "s"} ({order === "SEQUENTIAL" ? "one after another" : "all at once"}), {fields.length} field{fields.length === 1 ? "" : "s"}.{" "}
            {initialSigners.map((s) => `${s.name} <${s.email}>`).join(" · ")}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => act(() => saveOptions(env.id, options()))}>
              Save
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Send "${title}" to ${initialSigners.map((s) => s.name).join(", ")}?`)) return;
                start(async () => {
                  const r1 = await saveOptions(env.id, options());
                  if (!r1.ok) return setMsg(r1);
                  const r2 = await sendNow(env.id);
                  setMsg(r2);
                  router.refresh();
                });
              }}
            >
              {pending ? "Sending…" : "Send for signature"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
