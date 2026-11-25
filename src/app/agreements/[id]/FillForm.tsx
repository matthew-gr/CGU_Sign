"use client";

// FIL-1 to FIL-5: one form with every field, where its value came from, the missing ones listed first, switches for
// optional sections, and the signers' details. Values are checked on the server when saved.
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveValuesAction } from "@/lib/agreements/actions";
import { callAction } from "@/lib/call-action";
import type { FieldView, Party, SwitchView } from "@/lib/agreements/core";

type F = FieldView & { sourceText: string; originalDisplay: string };

const inputValue = (f: F) => (f.value === null || f.value === undefined ? "" : String(f.value));

export function FillForm({ id, fields, switches, parties }: { id: string; fields: F[]; switches: SwitchView[]; parties: Party[] }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.tag, inputValue(f)])));
  const [sw, setSw] = useState<Record<string, boolean>>(() => Object.fromEntries(switches.map((s) => [s.tag, s.on])));
  const [ps, setPs] = useState(parties);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const changed = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of fields) if (vals[f.tag] !== inputValue(f)) out[f.tag] = vals[f.tag];
    return out;
  }, [vals, fields]);
  const dirty = Object.keys(changed).length > 0 || switches.some((s) => sw[s.tag] !== s.on) || JSON.stringify(ps) !== JSON.stringify(parties);
  const missing = fields.filter((f) => f.missing);

  const save = () =>
    start(async () => {
      const r = await callAction(() => saveValuesAction(id, changed, sw, ps.map((p) => ({ signer: p.signer, name: p.name, email: p.email, company: p.company }))));
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Saved." });
      if (r.ok) router.refresh();
    });

  const control = (f: F) => {
    const common = { id: `f-${f.tag}`, className: "input", value: vals[f.tag] ?? "", disabled: f.locked && (f.source === "AIRTABLE" || f.source === "OVERRIDE") && f.value !== null, onChange: (e: { target: { value: string } }) => setVals((v) => ({ ...v, [f.tag]: e.target.value })) };
    if (f.type === "LONG_TEXT") return <textarea {...common} rows={5} />;
    if (f.type === "DATE") return <input {...common} type="date" />;
    if (f.type === "BOOLEAN")
      return (
        <select {...common}>
          <option value="">-</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    if (f.type === "MONEY" || f.type === "NUMBER" || f.type === "PERCENT") return <input {...common} inputMode="decimal" placeholder={f.type === "MONEY" ? "0.00" : ""} />;
    return <input {...common} type={f.type === "EMAIL" ? "email" : f.type === "PHONE" ? "tel" : "text"} />;
  };

  return (
    <div className="space-y-5">
      {missing.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          {missing.length} field{missing.length === 1 ? " needs" : "s need"} a value: {missing.map((f) => f.label).join(", ")}
        </div>
      )}
      {switches.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Optional sections</legend>
          {switches.map((s) => (
            <label key={s.tag} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={!!sw[s.tag]} onChange={(e) => setSw((x) => ({ ...x, [s.tag]: e.target.checked }))} />
              <span>
                {s.label}
                {s.help && <span className="block text-xs text-gra-ink-2">{s.help}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Fields</legend>
        {fields.map((f) =>
          f.needed ? (
            <div key={f.tag} className={f.type === "LONG_TEXT" ? "sm:col-span-2" : ""}>
              <label htmlFor={`f-${f.tag}`} className="label">
                {f.label}
                {f.required ? " *" : ""} <span className={`ml-1 rounded px-1 text-[10px] ${f.source === "OVERRIDE" ? "bg-amber-100 text-amber-900" : "bg-gra-page text-gra-ink-2"}`}>{f.sourceText}{f.airtableField && (f.source === "AIRTABLE" || f.source === "OVERRIDE") ? `: ${f.airtableField}` : ""}</span>
                {f.locked && <span className="ml-1 text-[10px] text-gra-muted">locked</span>}
              </label>
              <div className={f.missing ? "rounded-md ring-2 ring-amber-400" : ""}>{control(f)}</div>
              {f.source === "OVERRIDE" && <p className="mt-1 text-xs text-amber-900">Changed from Airtable value {f.originalDisplay || "(empty)"}. Airtable isn&apos;t changed.</p>}
              {f.error && <p className="mt-1 text-xs text-rose-700">{f.error}</p>}
              {f.help && <p className="mt-1 text-xs text-gra-ink-2">{f.help}</p>}
              {f.value !== null && f.display && f.display !== inputValue(f) && <p className="mt-1 text-xs text-gra-muted">Prints as: {f.display}</p>}
            </div>
          ) : null,
        )}
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Signers</legend>
        {ps.map((p, i) => (
          <div key={p.signer} className="grid gap-2 rounded-md border border-gra-hair p-3 sm:grid-cols-3">
            <div className="text-xs text-gra-ink-2 sm:col-span-3">
              Signer {p.signer}: {p.role} ({p.source === "LEAD" ? "from the lead" : p.source === "SIGNATORY" ? "company signatory" : "typed here"})
            </div>
            <input aria-label={`${p.role} name`} className="input" placeholder="Full name" value={p.name} disabled={p.source === "SIGNATORY"} onChange={(e) => setPs((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
            <input aria-label={`${p.role} email`} className="input" type="email" placeholder="Email" value={p.email} disabled={p.source === "SIGNATORY"} onChange={(e) => setPs((x) => x.map((y, j) => (j === i ? { ...y, email: e.target.value } : y)))} />
            <input aria-label={`${p.role} company`} className="input" placeholder="Company (optional)" value={p.company} disabled={p.source === "SIGNATORY"} onChange={(e) => setPs((x) => x.map((y, j) => (j === i ? { ...y, company: e.target.value } : y)))} />
          </div>
        ))}
      </fieldset>
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={!dirty || pending} onClick={save}>
          {pending ? "Saving..." : "Save"}
        </button>
        {dirty && <span className="text-xs text-gra-ink-2">Unsaved changes</span>}
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
    </div>
  );
}
