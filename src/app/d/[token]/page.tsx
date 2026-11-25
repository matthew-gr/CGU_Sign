// Downloading the completed document (public: the signed link from the completion email, then a fresh code). CMP-3.
// Signers get a session after the code; cc viewers type the code into the download form (src/app/d/[token]/download).
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { now } from "@/lib/clock";
import { appSettings } from "@/lib/settings";
import { parseViewerId } from "@/lib/sign/core";
import { viewersOf } from "@/lib/sign/config";
import { readDownloadToken, readSession, SESSION_COOKIE } from "@/lib/sign/tokens";
import { CodeGate } from "@/components/sign/CodeGate";
import { maskEmail, SignerShell, Stop } from "@/components/sign/SignerShell";
import { ViewerDownload } from "./ViewerDownload";

export const metadata: Metadata = { title: "Signed document", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function Download({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const company = (await appSettings()).companyName;
  const t = await now();
  const r = readDownloadToken(token, t);
  if (!r.ok)
    return (
      <SignerShell title="Signed document" company={company}>
        <Stop text={r.reason === "expired" ? "This download link has expired. Ask the sender for a copy." : "This link isn't valid."} />
      </SignerShell>
    );
  const viewer = parseViewerId(r.value.signerId);
  if (viewer) {
    const env = await db.signEnvelope.findUnique({ where: { id: viewer.envelopeId } });
    const v = env ? viewersOf(env)[viewer.index] : undefined;
    if (!env || !v || env.status !== "COMPLETED")
      return (
        <SignerShell title="Signed document" company={company}>
          <Stop text="This document isn't available." />
        </SignerShell>
      );
    return (
      <SignerShell title={env.title} company={company}>
        <ViewerDownload token={token} maskedEmail={maskEmail(v.email)} />
      </SignerShell>
    );
  }
  const signer = await db.signSigner.findUnique({ where: { id: r.value.signerId } });
  const env = signer ? await db.signEnvelope.findUnique({ where: { id: signer.envelopeId } }) : null;
  if (!signer || !env || env.status !== "COMPLETED")
    return (
      <SignerShell title="Signed document" company={company}>
        <Stop text="This document isn't available." />
      </SignerShell>
    );
  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, t, (sid) => (sid === signer.id ? signer.sessionNonce || null : null));
  return (
    <SignerShell title={env.title} company={company}>
      {session === signer.id ? (
        <div className="space-y-3 rounded-lg border border-gra-hair bg-white p-5">
          <p className="text-sm">Everyone has signed. The PDF has a certificate of completion on its last page. Keep a copy for your records.</p>
          <a className="btn-primary" href={`/api/sign/signer-file?s=${signer.id}&final=1`}>
            Download the signed PDF
          </a>
          <p className="text-xs text-gra-ink-2">
            SHA-256 of the signed file: <span className="font-mono break-all">{env.finalHash}</span>
          </p>
        </div>
      ) : (
        <CodeGate token={token} maskedEmail={maskEmail(signer.email)} purpose="DOWNLOAD" />
      )}
    </SignerShell>
  );
}
