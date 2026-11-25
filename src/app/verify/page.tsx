import { Card, PageTitle } from "@/components/ui";
import { VerifyForm } from "@/components/sign/VerifyForm";
import { appSettings } from "@/lib/settings";

export const metadata = { title: "Verify a signed PDF" };

/** CMP-4: public. Upload any PDF; the app says whether it's the final version of a completed agreement. */
export default async function VerifyPage() {
  const s = await appSettings();
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PageTitle title="Verify a signed PDF" subtitle={`Check whether a PDF is exactly the one ${s.companyName} produced when signing finished, unchanged.`} />
      <Card>
        <VerifyForm />
        <p className="mt-4 text-xs text-gra-ink-2">
          The SHA-256 fingerprint of every completed agreement is kept on record. Any change to the file, even one character, gives a different fingerprint. The file you upload is only hashed; it isn&apos;t stored.
        </p>
      </Card>
    </div>
  );
}
