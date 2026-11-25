import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { listTemplates } from "@/lib/templates/core";
import { appSettings } from "@/lib/settings";
import { dateShort } from "@/lib/tz";
import { uploadTemplate } from "@/lib/admin-actions";
import { ActionForm } from "@/components/ActionForm";
import { Card, Empty, PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Templates() {
  await requireAdmin();
  const list = await listTemplates(true);
  const tz = (await appSettings()).timeZone;
  return (
    <>
      <PageTitle title="Templates" subtitle="The client's own Word documents with {{tags}}. Each upload is a new version; agreements always record the version they were made from." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          {list.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Published</th>
                  <th>Latest upload</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.template.id}>
                    <td>
                      <Link className="link" href={`/templates/${t.template.id}`}>
                        {t.template.name}
                      </Link>
                      {t.template.archived && <span className="ml-2 text-xs text-gra-muted">archived</span>}
                    </td>
                    <td>{t.published ? `v${t.published.version}` : <span className="text-amber-800">not yet</span>}</td>
                    <td className="text-xs">
                      v{t.versions[0].version} · {dateShort(t.versions[0].createdAt, tz)}
                    </td>
                    <td>
                      <Link className="link text-xs" href={`/templates/${t.template.id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No templates yet. Upload the client&apos;s service agreement (.docx) to start.</Empty>
          )}
        </Card>
        <Card title="Upload a new template">
          <ActionForm action={uploadTemplate} submitLabel="Upload">
            <label className="block">
              <span className="label">Name</span>
              <input name="name" className="input" placeholder="Service Agreement" />
            </label>
            <input type="file" name="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required className="text-sm" />
          </ActionForm>
          <details className="mt-4 text-xs text-gra-ink-2">
            <summary className="cursor-pointer font-medium text-gra-ink">How to tag the Word document</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              <li>
                <code>{"{{clientName}}"}</code> a field. <code>{"{{depositAmount|usd}}"}</code> with a formatter: usd, usdWords, date, dateShort, upper, lower, title, number, percent, phone, lines.
              </li>
              <li>
                <code>{"{{#includeRushFee}}...{{/includeRushFee}}"}</code> an optional section; <code>{"{{^includeRushFee}}...{{/includeRushFee}}"}</code> shown when it&apos;s off.
              </li>
              <li>
                <code>{"{{sig:1}}"}</code> where signer 1 signs; also <code>{"{{date:1}}"}</code>, <code>{"{{name:1}}"}</code>, <code>{"{{title:2}}"}</code>, <code>{"{{initials:1}}"}</code>, <code>{"{{text:1:Label}}"}</code>, <code>{"{{check:1:Label}}"}</code>. A blank &quot;Date: ____&quot; next to a signature becomes the date signed.
              </li>
            </ul>
          </details>
        </Card>
      </div>
    </>
  );
}
