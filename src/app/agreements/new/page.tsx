import Link from "next/link";
import { getActor, isAdmin } from "@/lib/session";
import { listTemplates } from "@/lib/templates/core";
import { connection } from "@/lib/airtable/connection";
import { Card, Notice, PageTitle } from "@/components/ui";
import { NewAgreement } from "./NewAgreement";

export const dynamic = "force-dynamic";

export default async function NewAgreementPage() {
  const me = await getActor();
  const templates = await listTemplates(false);
  const c = await connection();
  const ready = !!c?.tableId;
  return (
    <>
      <PageTitle title="New agreement" subtitle="Pick a template and a lead from Airtable. The agreement is filled from the lead's record; you fill in anything missing before sending." />
      {!ready && (
        <div className="mb-4">
          <Notice tone="warn">
            Airtable isn&apos;t connected yet.{" "}
            {isAdmin(me) ? (
              <Link className="link" href="/settings/airtable">
                Connect it in Settings
              </Link>
            ) : (
              "Ask an Admin to connect it."
            )}
          </Notice>
        </div>
      )}
      {!templates.length && (
        <div className="mb-4">
          <Notice tone="warn">
            No published templates yet.{" "}
            {isAdmin(me) ? (
              <Link className="link" href="/templates">
                Upload one
              </Link>
            ) : (
              "Ask an Admin to publish one."
            )}
          </Notice>
        </div>
      )}
      <Card>
        <NewAgreement templates={templates.map((t) => ({ id: t.template.id, name: `${t.template.name} (v${t.published!.version})` }))} disabled={!ready || !templates.length} />
      </Card>
    </>
  );
}
