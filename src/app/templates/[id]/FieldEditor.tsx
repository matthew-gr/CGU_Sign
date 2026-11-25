"use client";

// TPL-3 and AIR-3: describe each field (label, type, required, help, default, range, lock) and where its value comes
// from: an Airtable field, a fixed value, or ask the user.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TemplateField } from "@prisma/client";
import { saveTemplateFields } from "@/lib/admin-actions";
import { callAction } from "@/lib/call-action";
import type { FieldEdit } from "@/lib/templates/core";
import type { ScanField } from "@/lib/templates/engine";
import { FIELD_TYPES, TYPE_LABEL, type FieldType } from "@/lib/templates/format";

type AF = { id: string; name: string; type: string; label: string };

export function FieldEditor({ versionId, fields, usage, airtableFields }: { versionId: string; fields: TemplateField[]; usage: ScanField[]; airtableFields: AF[] }) {
  const [rows, setRows] = useState<FieldEdit[]>(() =>
    fields.map((f) => ({ tag: f.tag, label: f.label, type: f.type as FieldType, required: f.required, help: f.help, defaultVal: f.defaultVal, min: f.min, max: f.max, locked: f.locked, source: f.source as FieldEdit["source"], airtableId: f.airtableId })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const set = (i: number, patch: Partial<FieldEdit>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const isSwitch = (tag: string) => fields.find((f) => f.tag === tag)?.isSwitch;

  const save = () =>
    start(async () => {
      const r = await callAction(() => saveTemplateFields(versionId, rows));
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Saved." });
      if (r.ok) router.refresh();
    });

  return (
    <div className="space-y-3">
      {rows.map((f, i) => {
        const u = usage.find((x) => x.tag === f.tag);
        const sw = isSwitch(f.tag);
        return (
          <div key={f.tag} className="rounded-md border border-gra-hair p-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <code className="text-xs">{sw ? `{{#${f.tag}}}` : `{{${f.tag}}}`}</code>
              <span className="text-xs text-gra-muted">
                {sw ? "optional section" : `used ${u?.count ?? 0}x${u?.formatters.length ? ` with |${u.formatters.join(", |")}` : ""}${u?.inSections.length ? `, only when ${u.inSections.map((s) => (s.startsWith("!") ? `${s.slice(1)} is off` : `${s} is on`)).join(" or ")}` : ""}`}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              <label className="sm:col-span-2">
                <span className="label">Label</span>
                <input className="input" value={f.label} onChange={(e) => set(i, { label: e.target.value })} />
              </label>
              {!sw && (
                <label>
                  <span className="label">Type</span>
                  <select className="input" value={f.type} onChange={(e) => set(i, { type: e.target.value as FieldType })}>
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!sw && (
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required
                </label>
              )}
              <label>
                <span className="label">Value comes from</span>
                <select className="input" value={f.source} onChange={(e) => set(i, { source: e.target.value as FieldEdit["source"] })}>
                  <option value="ASK">Ask the user</option>
                  <option value="AIRTABLE" disabled={!airtableFields.length}>
                    Airtable field
                  </option>
                  <option value="FIXED">Fixed value</option>
                </select>
              </label>
              {f.source === "AIRTABLE" && (
                <label className="sm:col-span-2">
                  <span className="label">Airtable field</span>
                  <select className="input" value={f.airtableId ?? ""} onChange={(e) => set(i, { airtableId: e.target.value })}>
                    <option value="">Pick a field</option>
                    {airtableFields.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.label})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className={f.source === "AIRTABLE" ? "" : "sm:col-span-2"}>
                <span className="label">{f.source === "FIXED" ? "Fixed value" : sw ? "Default (true/false)" : "Default (optional)"}</span>
                <input className="input" value={f.defaultVal ?? ""} onChange={(e) => set(i, { defaultVal: e.target.value })} />
              </label>
              {(f.type === "MONEY" || f.type === "NUMBER" || f.type === "PERCENT") && !sw && (
                <>
                  <label>
                    <span className="label">Minimum</span>
                    <input className="input" inputMode="decimal" value={f.min ?? ""} onChange={(e) => set(i, { min: e.target.value === "" ? null : Number(e.target.value) })} />
                  </label>
                  <label>
                    <span className="label">Maximum</span>
                    <input className="input" inputMode="decimal" value={f.max ?? ""} onChange={(e) => set(i, { max: e.target.value === "" ? null : Number(e.target.value) })} />
                  </label>
                </>
              )}
              <label className="sm:col-span-3">
                <span className="label">Help text</span>
                <input className="input" value={f.help ?? ""} onChange={(e) => set(i, { help: e.target.value })} />
              </label>
              {f.source === "AIRTABLE" && (
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input type="checkbox" checked={!!f.locked} onChange={(e) => set(i, { locked: e.target.checked })} /> Lock (no overrides)
                </label>
              )}
            </div>
          </div>
        );
      })}
      <button className="btn-primary" disabled={pending} onClick={save}>
        {pending ? "Saving..." : "Save fields"}
      </button>
      {msg && <p className={`text-sm whitespace-pre-line ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
    </div>
  );
}
