import { redirect } from "next/navigation";
import { currentSession, getActor } from "@/lib/session";
import { now } from "@/lib/clock";
import { checkAuthorize, consentNeedsLogin, isLoopback, OAuthError, type AuthorizeParams } from "@/lib/mcp/oauth";
import { approveClient } from "@/lib/mcp/actions";
import { Card, Notice, PageTitle } from "@/components/ui";

export const metadata = { title: "Connect an app" };

const FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;
type SP = Partial<Record<(typeof FIELDS)[number], string>>;

/**
 * OAuth consent for MCP clients such as Grok (MCP-1). Needs an email login from the last 10 minutes (LOG-6): otherwise
 * the user logs in again with a fresh code and comes back here. The app acts as them, with exactly their permissions.
 */
export default async function Authorize({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const back = `/oauth/authorize?${new URLSearchParams(FIELDS.flatMap((k) => (sp[k] ? [[k, sp[k]!]] : [])))}`;
  const me = await getActor(back);
  let client: Awaited<ReturnType<typeof checkAuthorize>> | null = null;
  let problem = "";
  try {
    client = await checkAuthorize(sp as Partial<AuthorizeParams>);
  } catch (e) {
    if (!(e instanceof OAuthError)) throw e;
    problem = e.message;
  }
  if (!problem && consentNeedsLogin((await currentSession())?.session, await now())) redirect(`/login?${new URLSearchParams({ next: back, reauth: "1" })}`);
  const host = sp.redirect_uri && !problem ? new URL(sp.redirect_uri).host : "";
  return (
    <div className="mx-auto max-w-lg">
      <PageTitle title="Connect an app" />
      {problem ? (
        <Notice tone="error">{problem}</Notice>
      ) : (
        <Card>
          <p className="text-[15px]">
            <strong>{client!.name}</strong> wants to act as <strong>{me.name}</strong> ({me.email}).
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
            <li>It can look up leads, prepare agreements from your templates, fill in named fields, and send agreements for signature, with your permissions. Nothing more.</li>
            <li>It can never change an agreement&apos;s wording: only the fields and optional sections your templates define.</li>
            <li>Sending or voiding needs you to confirm in the chat first. Every call it makes is logged, and Admins can review the log.</li>
            <li>You can disconnect it any time on My account. Sign out everywhere also ends it.</li>
          </ul>
          {isLoopback(sp.redirect_uri ?? "") && (
            <div className="mt-3">
              <Notice tone="warn">This returns to a program on a computer ({host}), not to a website. Only allow it if you started this yourself.</Notice>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">You&apos;ll go back to {host} after you choose.</p>
          <form action={approveClient as unknown as (fd: FormData) => Promise<void>} className="mt-5 flex gap-2">
            {FIELDS.map((k) => (sp[k] ? <input key={k} type="hidden" name={k} value={sp[k]} /> : null))}
            <button type="submit" name="decision" value="allow" className="btn-primary">
              Allow
            </button>
            <button type="submit" name="decision" value="deny" className="btn-secondary">
              Deny
            </button>
          </form>
        </Card>
      )}
    </div>
  );
}
