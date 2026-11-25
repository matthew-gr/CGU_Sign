"use client";

// TPL-4: for each signer N ({{sig:N}}), a role name, where the person comes from, and the signing order.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TemplateParty } from "@prisma/client";
import { saveTemplateParties } from "@/lib/admin-actions";
import { callAction } from "@/lib/call-action";
import type { PartyEdit } from "@/lib/templates/core";

type AF = { id: string; name: string; label: string };

export function PartyEditor({ versionId, parties, order: initialOrder, airtableFields, users }: { versionId: string; parties: TemplateParty[]; order: "SEQUENTIAL" | "PARALLEL"; airtableFields: AF[]; users: { id: string; name: string }[] }) {
  const [rows, setRows] = useState<PartyEdit[]>(() => parties.map((p) => ({ signer: p.signer, role: p.role, source: p.source as PartyEdit["source"], nameField: p.nameField, emailField: p.emailField, companyField: p.companyField, userId: p.userId })));
  const [order, setOrder] = useState(initialOrder);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const set = (i: number, patch: Partial<PartyEdit>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const pick = (value: string | undefined, onChange: (v: string) => void, label: string, optional = true) => (
    <label>
      <span className="label">{label}</span>
      <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{optional ? "(none)" : "Pick a field"}</option>
        {airtableFields.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );

  if (!rows.length) return <p className="text-sm text-gra-ink-2">Add {"{{sig:1}}"} anchors to the document to define who signs.</p>;
  return (
    <div className="space-y-3">
      {rows.map((p, i) => (
        <div key={p.signer} className="grid gap-2 rounded-md border border-gra-hair p-3 sm:grid-cols-3">
          <div className="text-xs font-semibold sm:col-span-3">Signer {p.signer} ({`{{sig:${p.signer}}}`})</div>
          <label>
            <span className="label">Role</span>
            <input className="input" value={p.role} onChange={(e) => set(i, { role: e.target.value })} />
          </label>
          <label className="sm:col-span-2">
            <span className="label">Who</span>
            <select className="input" value={p.source} onChange={(e) => set(i, { source: e.target.value as PartyEdit["source"] })}>
              <option value="LEAD">The lead (from Airtable)</option>
              <option value="SIGNATORY">A company signatory (a user)</option>
              <option value="TYPED">Typed in when sending</option>
            </select>
          </label>
          {p.source === "LEAD" && (
            <>
              {pick(p.emailField, (v) => set(i, { emailField: v }), "Email field", false)}
              {pick(p.nameField, (v) => set(i, { nameField: v }), "Name field")}
              {pick(p.companyField, (v) => set(i, { companyField: v }), "Company field")}
            </>
          )}
          {p.source === "SIGNATORY" && (
            <label className="sm:col-span-3">
              <span className="label">Signatory</span>
              <select className="input" value={p.userId ?? ""} onChange={(e) => set(i, { userId: e.target.value || null })}>
                <option value="">Pick a user</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      ))}
      <label className="block max-w-sm">
        <span className="label">Signing order</span>
        <select className="input" value={order} onChange={(e) => setOrder(e.target.value as "SEQUENTIAL" | "PARALLEL")}>
          <option value="SEQUENTIAL">One after another (signer 1 first)</option>
          <option value="PARALLEL">All at once</option>
        </select>
      </label>
      <button
        className="btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await callAction(() => saveTemplateParties(versionId, rows, order));
            setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Saved." });
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? "Saving..." : "Save parties"}
      </button>
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
    </div>
  );
}
