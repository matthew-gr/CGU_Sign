import { requireAdmin } from "@/lib/session";
import { appSettings } from "@/lib/settings";
import { dateTime } from "@/lib/tz";
import { mcpLog } from "@/lib/mcp/audit";
import { Card, Empty, PageTitle } from "@/components/ui";
import { SettingsNav } from "../SettingsNav";

export const dynamic = "force-dynamic";

/** MCP-4: every connector (Grok) call. */
export default async function ConnectorLog({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const me = await requireAdmin();
  const sp = await searchParams;
  const rows = await mcpLog(me, { outcome: sp.outcome });
  const tz = (await appSettings()).timeZone;
  return (
    <>
      <PageTitle title="Settings" />
      <SettingsNav at="/settings/log" />
      <Card title="Connector log" actions={<a className="link text-sm" href={sp.outcome ? "/settings/log" : "/settings/log?outcome=not_ok"}>{sp.outcome ? "Show all" : "Only problems"}</a>}>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>App</th>
                  <th>Tool</th>
                  <th>Outcome</th>
                  <th>Input</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="text-xs whitespace-nowrap">{dateTime(r.at, tz)}</td>
                    <td className="text-xs">{r.user}</td>
                    <td className="text-xs">{r.clientName}</td>
                    <td className="font-mono text-xs">{r.tool}</td>
                    <td className="text-xs">
                      {r.status}
                      {r.ms != null ? ` · ${r.ms} ms` : ""}
                      {!r.ok && r.result ? <div className="text-rose-700">{r.result.slice(0, 200)}</div> : null}
                    </td>
                    <td className="max-w-xs font-mono text-[11px] break-all text-gra-ink-2">{r.input}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No connector calls yet.</Empty>
        )}
      </Card>
    </>
  );
}
