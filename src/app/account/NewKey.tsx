"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { newApiKey } from "@/lib/mcp/actions";
import { callAction } from "@/lib/call-action";

/** Creates an API key and shows it once. */
export function NewKey() {
  const [name, setName] = useState("Grok");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input className="input" aria-label="Key name" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn-secondary shrink-0"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const fd = new FormData();
              fd.set("name", name);
              const r = await callAction(() => newApiKey(fd));
              if (r.error) setErr(r.error);
              else {
                setKey(r.key ?? "");
                router.refresh();
              }
            })
          }
        >
          Create key
        </button>
      </div>
      {key && (
        <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Copy this key now. It won&apos;t be shown again.
          <code className="mt-1 block break-all select-all">{key}</code>
        </div>
      )}
      {err && <p className="text-sm text-rose-700">{err}</p>}
    </div>
  );
}
