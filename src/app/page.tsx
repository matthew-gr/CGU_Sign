import Link from "next/link";
import { getActor, isAdmin } from "@/lib/session";
import { listAgreements, STATUS_LABEL } from "@/lib/agreements/core";
import { appSettings } from "@/lib/settings";
import { dateShort } from "@/lib/tz";
import { Card, Empty, PageTitle, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

const FILTERS = ["", "DRAFT", "SENT", "PARTIALLY_SIGNED", "COMPLETED", "DECLINED", "VOIDED", "EXPIRED"];

export default async function Home({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const me = await getActor();
  const sp = await searchParams;
  const status = FILTERS.includes(sp.status ?? "") ? (sp.status ?? "") : "";
  const rows = await listAgreements(me, { status: status || undefined, q: sp.q });
  const tz = (await appSettings()).timeZone;
  return (
    <>
      <PageTitle
        title="Agreements"
        subtitle={<>{isAdmin(me) ? "Every agreement made from a template." : "Agreements you've prepared from a template."} Uploaded documents are under <Link className="link" href="/envelopes">Uploaded documents</Link>.</>}
        actions={
          <span className="flex gap-2">
            <Link href="/envelopes/new" className="btn-secondary">
              Upload a document
            </Link>
            <Link href="/agreements/new" className="btn-primary">
              New agreement
            </Link>
          </span>
        }
      />
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <label>
          <span className="label">Status</span>
          <select name="status" defaultValue={status} className="input">
            {FILTERS.map((s) => (
              <option key={s} value={s}>
                {s ? STATUS_LABEL[s] : "All"}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-64 flex-1">
          <span className="label">Search</span>
          <input name="q" defaultValue={sp.q ?? ""} className="input" placeholder="Reference, title or lead" />
        </label>
        <button className="btn-secondary">Filter</button>
      </form>
      <Card>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Agreement</th>
                  <th>Lead</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono text-xs whitespace-nowrap">
                      <Link className="link" href={`/agreements/${a.id}`}>
                        {a.reference}
                      </Link>
                    </td>
                    <td>{a.title}</td>
                    <td className="text-gra-ink-2">{a.leadLabel}</td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="text-xs whitespace-nowrap">{dateShort(a.createdAt, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No agreements yet. Start one with New agreement.</Empty>
        )}
      </Card>
    </>
  );
}
