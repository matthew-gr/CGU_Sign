import Link from "next/link";
import { getActor } from "@/lib/session";
import { canCreateEnvelopes } from "@/lib/sign/config";
import { Card, Notice, PageTitle } from "@/components/ui";
import { Upload } from "@/components/sign/Upload";

/** Start a document from a ready PDF. Agreements made from Word templates start on their own pages. */
export default async function NewDocument() {
  const me = await getActor("/envelopes/new");
  return (
    <>
      <PageTitle
        title="Upload a document"
        subtitle="For anything that isn't made from a template: upload a PDF or a photo, add signers, place fields and send it for signature."
        actions={
          <Link href="/envelopes" className="btn-secondary">
            All documents
          </Link>
        }
      />
      {!canCreateEnvelopes(me) ? (
        <Notice tone="warn">Your account can&apos;t send documents for signature.</Notice>
      ) : (
        <div className="max-w-2xl">
          <Card title="Upload">
            <Upload />
          </Card>
        </div>
      )}
    </>
  );
}
