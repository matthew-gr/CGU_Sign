// A signer's page (public: the signed, single-use link, then a 6-digit code emailed to them). SIG-1 to SIG-5.
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { now } from "@/lib/clock";
import { appSettings } from "@/lib/settings";
import { blocked, loadSigner } from "@/lib/sign/core";
import { readSession, readSigningToken, SESSION_COOKIE, signerOfToken } from "@/lib/sign/tokens";
import { roomData } from "@/lib/sign/view";
import { SigningRoom } from "@/components/sign/SigningRoom";
import { CodeGate, NewLink } from "@/components/sign/CodeGate";
import { maskEmail, SignerShell, Stop } from "@/components/sign/SignerShell";

export const metadata: Metadata = { title: "Sign a document", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function Sign({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const company = (await appSettings()).companyName;
  const id = signerOfToken(token);
  const signer = id ? await db.signSigner.findUnique({ where: { id } }) : null;
  if (!signer)
    return (
      <SignerShell title="Signing link" company={company}>
        <Stop text="This signing link isn't valid. Check you opened the whole link from your email." />
      </SignerShell>
    );
  const st = await loadSigner(signer.id);
  const d = await roomData(signer.id);
  const why = await blocked(st);
  if (why)
    return (
      <SignerShell title={d.env.title} from={d.from} company={company}>
        <Stop text={why} />
      </SignerShell>
    );
  const t = await now();
  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, t, (sid) => (sid === signer.id ? st.signer.sessionNonce || null : null));
  if (session === signer.id && st.signer.verifiedAt)
    return (
      <SignerShell title={d.env.title} from={d.from} message={d.env.message} company={company}>
        <SigningRoom
          refs={{ token }}
          fileUrl={`/api/sign/signer-file?s=${signer.id}`}
          fields={d.fields}
          name={signer.name}
          consentText={d.consentText}
          today={d.today}
          saved={d.saved ? { signature: d.saved.signature, initials: d.saved.initials, method: d.saved.method } : null}
          canRemember={!!signer.userId}
        />
      </SignerShell>
    );
  const link = readSigningToken(token, t, () => st.signer.linkNonce || null);
  if (!link.ok)
    return (
      <SignerShell title={d.env.title} from={d.from} company={company}>
        <NewLink token={token} why={link.reason === "expired" ? "This link has expired." : link.reason === "used" ? "This link has already been used (each emailed link works once)." : "This link isn't valid."} />
      </SignerShell>
    );
  return (
    <SignerShell title={d.env.title} from={d.from} message={d.env.message} company={company}>
      <CodeGate token={token} maskedEmail={maskEmail(signer.email)} />
    </SignerShell>
  );
}
