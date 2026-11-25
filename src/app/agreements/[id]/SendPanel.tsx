"use client";

// SND-3/SND-4/SND-5: who signs, a message (no contract terms), sign-by date, order, cc viewers, then Send.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendAction } from "@/lib/agreements/actions";
import { callAction } from "@/lib/call-action";
import type { Party } from "@/lib/agreements/core";

export function SendPanel({ id, missing, parties, defaultOrder, defaultSignBy }: { id: string; missing: { tag: string; label: string; reason: string }[]; parties: Party[]; defaultOrder: "SEQUENTIAL" | "PARALLEL"; defaultSignBy: string }) {
  const [message, setMessage] = useState("");
  const [signBy, setSignBy] = useState(defaultSignBy);
  const [order, setOrder] = useState(defaultOrder);
  const [viewers, setViewers] = useState<{ name: string; email: string }[]>([]);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const send = () => {
    if (!window.confirm(`Send to ${parties.map((p) => `${p.name} <${p.email}>`).join(", ")}?`)) return;
    start(async () => {
      setError("");
      const r = await callAction(() => sendAction(id, { message, signBy, viewers: viewers.filter((v) => v.email.trim()), signingOrder: order }));
      if (r.error) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <div className="space-y-4 text-sm">
      <ol className="space-y-1">
        {parties.map((p) => (
          <li key={p.signer}>
            <b>{p.signer}.</b> {p.name || <i className="text-gra-muted">no name</i>} <span className="text-gra-ink-2">&lt;{p.email || "no email"}&gt;</span> · {p.role}
          </li>
        ))}
      </ol>
      <label className="block">
        <span className="label">Signing order</span>
        <select className="input" value={order} onChange={(e) => setOrder(e.target.value as "SEQUENTIAL" | "PARALLEL")}>
          <option value="SEQUENTIAL">One after another (in the order above)</option>
          <option value="PARALLEL">All at once</option>
        </select>
      </label>
      <label className="block">
        <span className="label">Sign by</span>
        <input type="date" className="input" value={signBy} onChange={(e) => setSignBy(e.target.value)} />
      </label>
      <label className="block">
        <span className="label">Message to signers (optional; goes in the email, never contract terms)</span>
        <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />
      </label>
      <div>
        <span className="label">Copy people on the completed agreement (optional)</span>
        {viewers.map((v, i) => (
          <div key={i} className="mb-2 flex gap-2">
            <input aria-label="Name" className="input" placeholder="Name" value={v.name} onChange={(e) => setViewers((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
            <input aria-label="Email" className="input" type="email" placeholder="Email" value={v.email} onChange={(e) => setViewers((x) => x.map((y, j) => (j === i ? { ...y, email: e.target.value } : y)))} />
            <button type="button" className="text-xs text-rose-700" onClick={() => setViewers((x) => x.filter((_, j) => j !== i))} aria-label="Remove">
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="text-xs text-gra-blue hover:underline" onClick={() => setViewers((x) => [...x, { name: "", email: "" }])}>
          + Add someone
        </button>
      </div>
      {missing.length > 0 ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">Fill in {missing.map((m) => m.label).join(", ")} before sending. Save the form first.</p>
      ) : null}
      {error && <p className="text-rose-700">{error}</p>}
      <button className="btn-primary w-full" disabled={pending || missing.length > 0} onClick={send}>
        {pending ? "Generating and sending..." : "Send for signature"}
      </button>
    </div>
  );
}
