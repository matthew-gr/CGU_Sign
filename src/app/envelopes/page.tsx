import Link from "next/link";
import { getActor } from "@/lib/session";
import { appSettings } from "@/lib/settings";
import { dateTime } from "@/lib/tz";
import { canCreateEnvelopes } from "@/lib/sign/config";
import { listFor, STATUS_LABEL, type ListTab } from "@/lib/sign/core";
import { Card, Empty, PageTitle } from "@/components/ui";
import { EnvelopeStatus } from "@/components/sign/Bits";

const TABS: [ListTab, string][] = [
  ["me", "Waiting for me"],
  ["others", "Waiting for others"],
  ["completed", "Completed"],
  ["drafts", "Drafts"],
  ["all", "All I can see"],
];

/** Other documents: ready PDFs sent for signature (SND-6), by what the viewer needs to do. Lists are filtered by access on the server. */
export default async function DocumentsHome({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; status?: string }> }) {
  const me = await getActor("/envelopes");
  const sp = await searchParams;
  const tz = (await appSettings()).timeZone;
  const tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? "me") as ListTab;
  const rows = await listFor(me, tab, sp.q ?? "", sp.status ?? "");
  const counts = Object.fromEntries(await Promise.all(TABS.slice(0, 4).map(async ([k]) => [k, (await listFor(me, k)).length] as const)));
  const creator = canCreateEnvelopes(me);
  const q = (t: string) => `/envelopes?tab=${t}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`;
  return (
    <>
      <PageTitle
        title="Uploaded documents"
        subtitle="Send any PDF or photo for e-signature: upload it, add signers, drag fields onto it and send. Signers confirm with a code emailed to them; the result is a locked PDF with a completion certificate."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/verify" className="btn-secondary">
              Verify a PDF
            </Link>
            {creator && (
              <Link href="/envelopes/new" className="btn-primary">
                + Upload a document
              </Link>
            )}
          </div>
        }
      />
      <nav className="mb-4 flex flex-wrap gap-1.5 text-sm">
        {TABS.map(([k, l]) => (
          <Link key={k} href={q(k)} className={`rounded-full px-3 py-1 ${tab === k ? "bg-gra-deep text-white" : "bg-white text-gra-ink-2"}`}>
            {l}
            {k in counts && counts[k] ? <span className="ml-1.5 rounded-full bg-white/20 px-1.5 text-xs">{counts[k]}</span> : null}
          </Link>
        ))}
      </nav>
      <form className="mb-4 flex flex-wrap gap-2" action="/envelopes">
        <input type="hidden" name="tab" value={tab} />
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Search title, signer or company" className="input max-w-sm" />
        <select name="status" defaultValue={sp.status ?? ""} className="input max-w-[12rem]" aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(STATUS_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <button className="btn-secondary">Filter</button>
      </form>
      <Card>
        {!rows.length ? (
          <Empty>{tab === "me" ? "Nothing is waiting for your signature." : "Nothing here."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Status</th>
                  <th>Signers</th>
                  <th>Sent</th>
                  <th>Sign by / completed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ env, signers, myTurn, mine }) => (
                  <tr key={env.id}>
                    <td>
                      <Link href={`/envelopes/${env.id}`} className="link font-medium">
                        {env.title}
                      </Link>
                      <div className="text-xs text-gra-muted">
                        {env.fileName}
                        {env.confidential ? " · confidential" : ""}
                      </div>
                    </td>
                    <td>
                      <EnvelopeStatus status={env.status} />
                    </td>
                    <td className="text-xs">
                      {signers.map((s) => (
                        <div key={s.id} className="whitespace-nowrap">
                          {s.status === "SIGNED" ? "✓" : s.status === "DECLINED" ? "✕" : "·"} {s.name}
                          {s.role ? <span className="text-gra-muted"> ({s.role})</span> : null}
                        </div>
                      ))}
                    </td>
                    <td className="text-xs whitespace-nowrap">{dateTime(env.sentAt, tz)}</td>
                    <td className="text-xs whitespace-nowrap">{env.status === "COMPLETED" ? dateTime(env.completedAt, tz) : dateTime(env.expiresAt, tz)}</td>
                    <td className="text-right text-xs text-gra-ink-2">{myTurn && mine ? "Your turn: use the link in your email" : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
