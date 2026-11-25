import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { appSettings } from "@/lib/settings";
import { dateTime } from "@/lib/tz";
import { publishProblems, scanOf, versionFull } from "@/lib/templates/core";
import { connection, leadsTable } from "@/lib/airtable/connection";
import { AIRTABLE_TYPE_LABEL, UNMAPPABLE } from "@/lib/airtable/convert";
import { archiveTemplate, publishVersion, renameTemplate, uploadTemplate } from "@/lib/admin-actions";
import { listUsers } from "@/lib/users";
import { ActionForm } from "@/components/ActionForm";
import { Card, Notice, PageTitle } from "@/components/ui";
import { FieldEditor } from "./FieldEditor";
import { PartyEditor } from "./PartyEditor";

export const dynamic = "force-dynamic";

export default async function TemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const template = await db.template.findUnique({ where: { id } });
  if (!template) notFound();
  const versions = await db.templateVersion.findMany({ where: { templateId: id }, orderBy: { version: "desc" } });
  const current = versions.find((v) => v.id === sp.v) ?? versions[0];
  const v = await versionFull(current.id);
  const scan = scanOf(v);
  const problems = publishProblems(v);
  const tz = (await appSettings()).timeZone;
  let airtableFields: { id: string; name: string; type: string; label: string }[] = [];
  let airtableError = "";
  if ((await connection())?.tableId) {
    try {
      airtableFields = (await leadsTable()).fields.filter((f) => !UNMAPPABLE.has(f.type)).map((f) => ({ id: f.id, name: f.name, type: f.type, label: AIRTABLE_TYPE_LABEL[f.type] ?? f.type }));
    } catch (e) {
      airtableError = (e as Error).message;
    }
  } else airtableError = "Airtable isn't connected yet, so fields can't be mapped to it. Connect it in Settings → Airtable.";
  const users = (await listUsers()).map((u) => ({ id: u.id, name: `${u.name} (${u.email})` }));
  const agreements = await db.agreement.count({ where: { templateVersionId: v.id } });

  return (
    <>
      <PageTitle
        title={template.name}
        subtitle={
          <>
            Version {v.version} · {v.fileName} · uploaded {dateTime(v.createdAt, tz)} · SHA-256 <span className="font-mono">{v.sha256.slice(0, 16)}...</span> · {agreements} agreement{agreements === 1 ? "" : "s"}
          </>
        }
        actions={
          <span className="flex flex-wrap gap-2">
            <a className="btn-secondary" href={`/api/templates/${v.id}?kind=docx`}>
              Download .docx
            </a>
            <a className="btn-secondary" href={`/api/templates/${v.id}?kind=test`} target="_blank" rel="noreferrer">
              Test fill (PDF)
            </a>
          </span>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {versions.map((x) => (
          <Link key={x.id} href={`/templates/${id}?v=${x.id}`} className={`rounded-full px-3 py-1 ${x.id === v.id ? "bg-gra-blue text-white" : "bg-white text-gra-ink-2"}`}>
            v{x.version}
            {x.published ? " · published" : ""}
          </Link>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          {scan.problems.length > 0 && (
            <Notice tone="error">
              The document has problems to fix in Word before this version can be published:
              {"\n- " + scan.problems.join("\n- ")}
            </Notice>
          )}
          <Card title="Fields">
            {airtableError && (
              <div className="mb-3">
                <Notice tone="warn">{airtableError}</Notice>
              </div>
            )}
            <FieldEditor versionId={v.id} fields={v.fields} usage={scan.fields} airtableFields={airtableFields} />
          </Card>
          <Card title="Signing parties">
            <PartyEditor versionId={v.id} parties={v.parties} order={v.signingOrder as "SEQUENTIAL" | "PARALLEL"} airtableFields={airtableFields} users={users} />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Publish">
            {v.published ? (
              <p className="text-sm text-emerald-800">Published{v.publishedAt ? ` ${dateTime(v.publishedAt, tz)}` : ""}. {versions.find((x) => x.published)?.id === v.id ? "New agreements use this version." : "A newer version is published."}</p>
            ) : problems.length ? (
              <Notice tone="warn">{"Before publishing:\n- " + problems.join("\n- ")}</Notice>
            ) : (
              <ActionForm action={publishVersion} submitLabel={`Publish v${v.version}`}>
                <input type="hidden" name="versionId" value={v.id} />
                <p className="text-sm text-gra-ink-2">Check the layout with Test fill first. New agreements will use this version.</p>
              </ActionForm>
            )}
          </Card>
          <Card title="Upload the next version">
            <ActionForm action={uploadTemplate} submitLabel="Upload">
              <input type="hidden" name="templateId" value={id} />
              <input type="file" name="file" accept=".docx" required className="text-sm" />
              <p className="text-xs text-gra-ink-2">Field descriptions and parties carry over by tag name. New tags need describing before publishing.</p>
            </ActionForm>
          </Card>
          <Card title="Template">
            <div className="space-y-4">
              <ActionForm action={renameTemplate} submitLabel="Rename" submitClass="btn-secondary" inline>
                <input type="hidden" name="templateId" value={id} />
                <input name="name" defaultValue={template.name} className="input" aria-label="Template name" />
              </ActionForm>
              <ActionForm action={archiveTemplate} submitLabel={template.archived ? "Restore" : "Archive"} submitClass="btn-secondary">
                <input type="hidden" name="templateId" value={id} />
                <input type="hidden" name="archived" value={template.archived ? "0" : "1"} />
                <p className="text-xs text-gra-ink-2">{template.archived ? "Archived: not offered for new agreements." : "Archiving stops new agreements; existing ones keep working."}</p>
              </ActionForm>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
