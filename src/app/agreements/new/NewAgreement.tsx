"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createAgreementAction, searchLeadsAction } from "@/lib/agreements/actions";
import { callAction } from "@/lib/call-action";

type Lead = { id: string; label: string; detail: string };

export function NewAgreement({ templates, disabled }: { templates: { id: string; name: string }[]; disabled: boolean }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  // Live search, debounced.
  useEffect(() => {
    if (disabled || q.trim().length < 2) return setLeads([]);
    const t = setTimeout(async () => {
      setSearching(true);
      const r = await searchLeadsAction(q);
      setSearching(false);
      if (r.error) setError(r.error);
      else {
        setError("");
        setLeads(r.items ?? []);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q, disabled]);

  const create = () =>
    start(async () => {
      const fd = new FormData();
      fd.set("templateId", templateId);
      fd.set("recordId", lead!.id);
      const r = await callAction(() => createAgreementAction(fd));
      if (r.error) return setError(r.error);
      router.push(r.href!);
    });

  return (
    <div className="space-y-4">
      <label className="block max-w-md">
        <span className="label">Template</span>
        <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={disabled}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <div>
        <label className="block max-w-md">
          <span className="label">Lead</span>
          <input className="input" placeholder="Search by name, company or email, or paste a record link" value={q} onChange={(e) => setQ(e.target.value)} disabled={disabled} />
        </label>
        {searching && <p className="mt-1 text-xs text-gra-muted">Searching Airtable...</p>}
        {!!leads.length && (
          <ul className="mt-2 max-w-xl divide-y divide-gra-hair rounded-md border border-gra-hair bg-white">
            {leads.map((l) => (
              <li key={l.id}>
                <button type="button" className={`w-full px-3 py-2 text-left text-sm hover:bg-gra-wash ${lead?.id === l.id ? "bg-gra-wash" : ""}`} onClick={() => setLead(l)}>
                  <span className="font-medium">{l.label}</span>
                  {l.detail && <span className="text-gra-ink-2"> · {l.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!searching && q.trim().length >= 2 && !leads.length && !error && <p className="mt-1 text-xs text-gra-muted">No matching leads.</p>}
      </div>
      {lead && (
        <p className="text-sm">
          Selected: <b>{lead.label}</b> {lead.detail && <span className="text-gra-ink-2">({lead.detail})</span>}
        </p>
      )}
      {error && <p className="text-sm text-rose-700">{error}</p>}
      <button className="btn-primary" disabled={disabled || !lead || !templateId || pending} onClick={create}>
        {pending ? "Filling from Airtable..." : "Create agreement"}
      </button>
    </div>
  );
}
