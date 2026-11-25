import { getActor } from "@/lib/session";
import { appSettings } from "@/lib/settings";
import { dateTime } from "@/lib/tz";
import { savedSignature } from "@/lib/sign/core";
import { connectionsOf, mcpUrl } from "@/lib/mcp/oauth";
import { keysOf } from "@/lib/mcp/keys";
import { mcpConfig } from "@/lib/mcp/config";
import { disconnectApp, revokeApiKey } from "@/lib/mcp/actions";
import { signOutEverywhere } from "@/lib/admin-actions";
import { ActionForm } from "@/components/ActionForm";
import { MySignature } from "@/components/sign/MySignature";
import { Card, PageTitle } from "@/components/ui";
import { NewKey } from "./NewKey";

export const dynamic = "force-dynamic";

export default async function Account() {
  const me = await getActor();
  const tz = (await appSettings()).timeZone;
  const saved = await savedSignature(me.id);
  const apps = await connectionsOf(me.id);
  const keys = await keysOf(me.id);
  return (
    <>
      <PageTitle title="My account" subtitle={`${me.name} · ${me.email} · ${me.role === "ADMIN" ? "Admin" : "Sender"}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="My signature">
          <MySignature name={me.name} saved={saved} />
        </Card>
        <Card title="Grok and other connected apps">
          <p className="mb-3 text-sm text-gra-ink-2">
            Connector address: <code className="break-all">{mcpUrl()}</code>. Add it in Grok as a remote MCP server; it asks you to sign in here and approve.
          </p>
          {apps.length ? (
            <ul className="space-y-2 text-sm">
              {apps.map((a) => (
                <li key={a.family} className="flex items-center justify-between gap-2">
                  <span>
                    {a.clientName} <span className="text-xs text-gra-ink-2">· connected {dateTime(a.connectedAt, tz)} · last used {dateTime(a.lastUsedAt, tz) || "never"}</span>
                  </span>
                  <ActionForm action={disconnectApp} submitLabel="Disconnect" submitClass="text-xs text-rose-700 hover:underline" inline>
                    <input type="hidden" name="family" value={a.family} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gra-ink-2">No apps connected.</p>
          )}
          {mcpConfig().apiKeys && (
            <div className="mt-5 border-t border-gra-hair pt-4">
              <h3 className="text-sm font-semibold">API keys</h3>
              <p className="mb-2 text-xs text-gra-ink-2">For a client that can&apos;t sign in with OAuth: send the key as &quot;Authorization: Bearer ...&quot; to the connector address. It acts as you.</p>
              <ul className="mb-3 space-y-2 text-sm">
                {keys.map((k) => (
                  <li key={k.id} className="flex items-center justify-between gap-2">
                    <span>
                      {k.name} <code className="text-xs">{k.prefix}...</code> <span className="text-xs text-gra-ink-2">· last used {dateTime(k.lastUsedAt, tz) || "never"}</span>
                    </span>
                    <ActionForm action={revokeApiKey} submitLabel="Revoke" submitClass="text-xs text-rose-700 hover:underline" inline>
                      <input type="hidden" name="id" value={k.id} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
              <NewKey />
            </div>
          )}
        </Card>
        <Card title="Sessions">
          <ActionForm action={signOutEverywhere} submitLabel="Sign out everywhere" submitClass="btn-secondary" confirm="Sign out on every device, and disconnect every connected app?">
            <p className="text-sm text-gra-ink-2">Ends every session on every device and disconnects connected apps. API keys stay until you revoke them.</p>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
