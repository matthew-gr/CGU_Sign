import { requireAdmin } from "@/lib/session";
import { appSettings } from "@/lib/settings";
import { dateTime } from "@/lib/tz";
import { bases, connection, searchFieldIds, tables, type WriteBackMap } from "@/lib/airtable/connection";
import { AIRTABLE_TYPE_LABEL } from "@/lib/airtable/convert";
import { chooseAirtableTable, disconnectAirtable, saveAirtableToken, saveWriteBack } from "@/lib/admin-actions";
import { ActionForm } from "@/components/ActionForm";
import { Card, Notice, PageTitle } from "@/components/ui";
import { SettingsNav } from "../SettingsNav";

export const dynamic = "force-dynamic";

export default async function AirtableSettings({ searchParams }: { searchParams: Promise<{ base?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const c = await connection();
  const tz = (await appSettings()).timeZone;
  let error = "";
  let baseList: { id: string; name: string }[] = [];
  let tableList: Awaited<ReturnType<typeof tables>> = [];
  const baseId = sp.base ?? c?.baseId ?? "";
  if (c?.tokenEnc) {
    try {
      baseList = await bases();
      if (baseId) tableList = await tables(baseId, true);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const table = tableList.find((t) => t.id === c?.tableId);
  const wb = JSON.parse(c?.writeBackMap || "{}") as WriteBackMap;
  const chosen = c ? searchFieldIds(c) : [];
  const fieldSelect = (name: keyof WriteBackMap, label: string) => (
    <label>
      <span className="label">{label}</span>
      <select name={name} className="input" defaultValue={wb[name] ?? ""}>
        <option value="">(don&apos;t write)</option>
        {table?.fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} ({AIRTABLE_TYPE_LABEL[f.type] ?? f.type})
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <PageTitle title="Settings" />
      <SettingsNav at="/settings/airtable" />
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {c?.lastError && !error && (
        <div className="mb-4">
          <Notice tone="warn">Last Airtable error: {c.lastError}</Notice>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="1. Access token">
          {c?.tokenEnc ? (
            <p className="mb-3 text-sm">
              Connected{c.baseName ? ` to base ${c.baseName}` : ""}
              {c.tableName ? `, table ${c.tableName}` : ""}. Last checked {dateTime(c.lastCheckedAt, tz) || "never"}. The token is stored encrypted and isn&apos;t shown again.
            </p>
          ) : (
            <p className="mb-3 text-sm text-gra-ink-2">
              In Airtable, create a personal access token (airtable.com/create/tokens) with the scopes <code>data.records:read</code> and <code>schema.bases:read</code> (add <code>data.records:write</code> for write-back), and give it access to the client&apos;s base only.
            </p>
          )}
          <ActionForm action={saveAirtableToken} submitLabel={c?.tokenEnc ? "Replace token" : "Connect"}>
            <input name="token" type="password" autoComplete="off" className="input" placeholder="pat..." required />
          </ActionForm>
          {c?.tokenEnc && (
            <ActionForm action={disconnectAirtable} submitLabel="Disconnect Airtable" submitClass="mt-3 text-xs text-rose-700 hover:underline" confirm="Disconnect Airtable? New agreements can't be made until it's connected again.">
              <span />
            </ActionForm>
          )}
        </Card>
        {c?.tokenEnc && (
          <Card title="2. Base and leads table">
            <form className="mb-3 flex items-end gap-2">
              <label className="flex-1">
                <span className="label">Base</span>
                <select name="base" className="input" defaultValue={baseId}>
                  <option value="">Pick a base</option>
                  {baseList.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn-secondary">Show tables</button>
            </form>
            {baseId && (
              <ActionForm action={chooseAirtableTable} submitLabel="Save" keepValues>
                <input type="hidden" name="baseId" value={baseId} />
                <label className="block">
                  <span className="label">Leads table</span>
                  <select name="tableId" className="input" defaultValue={c.tableId}>
                    {tableList.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.fields.length} fields)
                      </option>
                    ))}
                  </select>
                </label>
                {table && (
                  <fieldset>
                    <legend className="label">Fields that identify a lead in search (up to 5; the first is the main label)</legend>
                    <div className="grid max-h-60 gap-1 overflow-y-auto text-sm sm:grid-cols-2">
                      {table.fields.map((f) => (
                        <label key={f.id} className="flex items-center gap-2">
                          <input type="checkbox" name="searchFields" value={f.id} defaultChecked={chosen.includes(f.id)} /> {f.name}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
              </ActionForm>
            )}
          </Card>
        )}
        {table && (
          <Card title="3. Write status back to Airtable (optional)">
            <ActionForm action={saveWriteBack} submitLabel="Save" keepValues>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="writeBack" defaultChecked={c?.writeBack} /> Write each agreement&apos;s status, dates and link into the lead&apos;s record
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                {fieldSelect("status", "Status (Sent, Viewed, Signed, ...)")}
                {fieldSelect("sentAt", "Sent date")}
                {fieldSelect("signedAt", "Signed date")}
                {fieldSelect("link", "Link to the agreement")}
              </div>
              <p className="text-xs text-gra-ink-2">Failed writes are retried with backoff and never block signing. The token needs data.records:write.</p>
            </ActionForm>
          </Card>
        )}
        {table && (
          <Card title="Leads table fields">
            <ul className="grid gap-1 text-xs sm:grid-cols-2">
              {table.fields.map((f) => (
                <li key={f.id}>
                  <b>{f.name}</b> <span className="text-gra-ink-2">{AIRTABLE_TYPE_LABEL[f.type] ?? f.type}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-gra-ink-2">Map these to template fields on each template&apos;s page.</p>
          </Card>
        )}
      </div>
    </>
  );
}
