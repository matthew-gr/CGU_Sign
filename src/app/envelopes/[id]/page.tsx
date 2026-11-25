import Link from "next/link";
import { headers } from "next/headers";
import { getActor } from "@/lib/session";
import { db } from "@/lib/db";
import { now, plusDays } from "@/lib/clock";
import { appSettings } from "@/lib/settings";
import { dateTime, ymdIn } from "@/lib/tz";
import { canManage, viewersOf } from "@/lib/sign/config";
import { ACTIVE, anchorSummary, currentTurn, openEnvelope, ownerLink, SignError, templatesFor } from "@/lib/sign/core";
import { deleteIt, extendIt, paperIt, remindIt, replacePdf, reviseIt, voidIt } from "@/lib/sign/actions";
import { ActionForm } from "@/components/ActionForm";
import { Card, Notice, PageTitle } from "@/components/ui";
import { EnvelopeStatus } from "@/components/sign/Bits";
import { Prepare } from "@/components/sign/Prepare";
import { CopyLink } from "@/components/sign/CopyLink";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getActor(`/envelopes/${id}`);
  const h = await headers();
  let a;
  try {
    a = await openEnvelope(me, id, { ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim(), ua: h.get("user-agent") ?? "" });
  } catch (e) {
    return (
      <>
        <PageTitle title="Document" />
        <Notice tone="warn">{e instanceof SignError ? e.message : "Document not found."}</Notice>
      </>
    );
  }
  const { env, signers, role } = a;
  const manage = canManage(me, env);
  const agreement = env.source === "AGREEMENT";
  const settings = await appSettings();
  const tz = settings.timeZone;
  const when = (d: Date | null | undefined) => dateTime(d, tz);
  const t = await now();

  if (env.status === "DRAFT" && manage && !agreement) {
    const fields = await db.signField.findMany({ where: { envelopeId: id } });
    return (
      <>
        <PageTitle
          title={env.title}
          subtitle={
            <>
              Draft · {env.pageCount} page{env.pageCount === 1 ? "" : "s"} · {env.fileName}
            </>
          }
          actions={
            <Link href="/envelopes?tab=drafts" className="btn-secondary">
              All drafts
            </Link>
          }
        />
        {env.sentAt && (
          <div className="mb-4">
            <Notice tone="info">Back in draft to revise. When you send it again, signers get the updated version as an amendment, with a new link.</Notice>
          </div>
        )}
        <Prepare
          key={env.originalHash /* a replaced PDF remounts the editor with the new pages and fields */}
          env={{
            id: env.id,
            title: env.title,
            message: env.message,
            expires: ymdIn(env.expiresAt ?? plusDays(t, settings.expiryDays), tz),
            viewers: viewersOf(env).map((v) => ({ name: v.name ?? "", email: v.email })),
            confidential: env.confidential,
            signingOrder: env.signingOrder as "SEQUENTIAL" | "PARALLEL",
            pageCount: env.pageCount,
          }}
          signers={signers.map((s) => ({ id: s.id, order: s.order, name: s.name, email: s.email, company: s.company, role: s.role }))}
          fields={fields.map((f) => ({ signerId: f.signerId, type: f.type as never, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label, placedBy: f.placedBy }))}
          templates={(await templatesFor(env.pageCount)).map((x) => ({ id: x.id, name: x.name, signerCount: x.signerCount }))}
          anchors={await anchorSummary(id)}
        />
        <div className="mt-5">
          <Card title="Replace the PDF">
            <ActionForm action={replacePdf} submitLabel="Upload the new PDF" submitClass="btn-secondary" confirm="Replace the document with this PDF? Signers, fields and settings stay as they are.">
              <input type="hidden" name="id" value={env.id} />
              <p className="text-xs text-gra-ink-2">To fix the document before it&apos;s signed: edit it in Word or Google Docs, save it as a PDF and upload it here. Fields stay where they are, so check them before you send.</p>
              <input type="file" name="file" accept="application/pdf,.pdf" required className="input py-1.5" aria-label="New PDF" />
            </ActionForm>
          </Card>
        </div>
        <div className="mt-5">
          <Card title="Delete this draft">
            <ActionForm action={deleteIt} submitLabel="Delete" submitClass="btn-secondary text-rose-800" confirm="Delete this draft and its document? This can't be undone.">
              <input type="hidden" name="id" value={env.id} />
              <p className="text-xs text-gra-ink-2">{env.sentAt ? "Signers were already told the earlier link stopped working; they won't hear anything more." : "Nobody has been sent anything yet."}</p>
            </ActionForm>
          </Card>
        </div>
        <div className="mt-5">
          <Card title="Signed on paper instead?">
            <ActionForm action={paperIt} submitLabel="Upload the signed scan" submitClass="btn-secondary" confirm="Mark this document as signed on paper? The scan becomes the final document.">
              <input type="hidden" name="id" value={env.id} />
              <input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required className="input py-1.5" aria-label="Signed scan" />
            </ActionForm>
          </Card>
        </div>
      </>
    );
  }

  const turn = ACTIVE.includes(env.status) ? currentTurn(env, signers) : [];
  const anySigned = signers.some((s) => s.status === "SIGNED");
  const mine = signers.find((s) => s.userId === me.id || s.email.toLowerCase() === me.email.toLowerCase());
  const events = manage ? await db.signEvent.findMany({ where: { envelopeId: id }, orderBy: { at: "desc" }, take: 60 }) : [];
  const names = new Map(signers.map((s) => [s.id, s.name]));
  const actors = new Map((await db.user.findMany({ where: { id: { in: events.map((e) => e.actorId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const owner = await db.user.findUnique({ where: { id: env.ownerId }, select: { name: true } });
  const viewers = viewersOf(env);
  const which = env.status === "COMPLETED" ? "final" : "current";

  return (
    <>
      <PageTitle
        title={env.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <EnvelopeStatus status={env.status} />
            <span>
              {agreement ? "Agreement" : "Uploaded"} by {owner?.name ?? "—"} · {env.signingOrder === "SEQUENTIAL" ? "one after another" : "any order"}
              {env.confidential ? " · confidential" : ""}
            </span>
          </span>
        }
        actions={
          <Link href={agreement ? ownerLink(env) : "/envelopes"} className="btn-secondary">
            {agreement ? "Agreement page" : "All documents"}
          </Link>
        }
      />
      {agreement && (
        <div className="mb-4">
          <Notice tone="info">
            This agreement is managed on its agreement page.{" "}
            <Link href={ownerLink(env)} className="font-semibold underline">
              Open the agreement →
            </Link>
          </Notice>
        </div>
      )}
      {mine && turn.some((s) => s.id === mine.id) && (
        <div className="mb-4">
          <Notice tone="info">It&apos;s your turn to sign. Use the signing link emailed to {mine.email}: you&apos;ll confirm with a 6-digit code sent to that address. If you can&apos;t find the email, ask the sender for a reminder.</Notice>
        </div>
      )}
      {env.reason && (env.status === "DECLINED" || env.status === "VOIDED") && (
        <div className="mb-4">
          <Notice tone="warn">
            {env.status === "DECLINED" ? "Declined" : "Voided"}: {env.reason}
          </Notice>
        </div>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <Card title="Signers">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Signer</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Viewed</th>
                    <th>Signed</th>
                  </tr>
                </thead>
                <tbody>
                  {signers.map((s) => (
                    <tr key={s.id}>
                      <td>{s.order}</td>
                      <td>
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs text-gra-muted">
                          {s.email}
                          {s.company ? ` · ${s.company}` : ""}
                        </div>
                        {s.declineReason && <div className="text-xs text-rose-700">Declined: {s.declineReason}</div>}
                        {manage && turn.some((x) => x.id === s.id) && <CopyLink signerId={s.id} />}
                      </td>
                      <td className="text-xs">{s.role || "—"}</td>
                      <td className="text-xs">{s.status === "WAITING" ? "Not their turn yet" : s.status === "SENT" ? "Sent" : s.status === "VIEWED" ? "Viewed" : s.status === "SIGNED" ? "✓ Signed" : "Declined"}</td>
                      <td className="text-xs whitespace-nowrap">{when(s.viewedAt)}</td>
                      <td className="text-xs whitespace-nowrap">{when(s.signedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-gra-ink-2">Every signer confirms who they are with a 6-digit code emailed to them.</p>
          </Card>
          <Card
            title={env.status === "COMPLETED" ? (env.completionMethod === "PAPER" ? "Signed on paper (scan)" : "Signed document") : "Document"}
            actions={
              <span className="flex gap-2">
                <a className="btn-secondary text-xs" href={`/api/sign/file/${env.id}?which=${which}&download=1`}>
                  Download
                </a>
                {role !== "signer" && (
                  <a className="btn-secondary text-xs" href={`/api/sign/file/${env.id}?which=original&download=1`}>
                    Original
                  </a>
                )}
              </span>
            }
          >
            <iframe src={`/api/sign/file/${env.id}?which=${which}`} title={env.title} className="h-[70vh] w-full rounded-xl border border-gra-hair bg-gra-page" />
            <dl className="mt-3 grid gap-1 text-xs text-gra-ink-2">
              <div>
                <dt className="inline font-semibold">Original SHA-256 </dt>
                <dd className="inline font-mono break-all">{env.originalHash}</dd>
              </div>
              {env.finalHash && (
                <div>
                  <dt className="inline font-semibold">Final SHA-256 </dt>
                  <dd className="inline font-mono break-all">{env.finalHash}</dd>
                </div>
              )}
              {env.status === "COMPLETED" && env.certNote && <div>{env.certNote}</div>}
            </dl>
          </Card>
        </div>
        <aside className="space-y-5">
          <Card title="Details">
            <dl className="space-y-1.5 text-sm">
              <div>
                <dt className="text-xs text-gra-muted">Sent</dt>
                <dd>{when(env.sentAt) || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-gra-muted">{env.status === "COMPLETED" ? "Completed" : "Sign by"}</dt>
                <dd>{(env.status === "COMPLETED" ? when(env.completedAt) : when(env.expiresAt)) || "—"}</dd>
              </div>
              {viewers.length > 0 && (
                <div>
                  <dt className="text-xs text-gra-muted">Copied to</dt>
                  <dd>{viewers.map((v) => (v.name ? `${v.name} <${v.email}>` : v.email)).join(", ")}</dd>
                </div>
              )}
              {env.message && (
                <div>
                  <dt className="text-xs text-gra-muted">Message</dt>
                  <dd className="whitespace-pre-line">{env.message}</dd>
                </div>
              )}
            </dl>
          </Card>
          {manage && ACTIVE.includes(env.status) && (
            <Card title="Manage">
              <div className="space-y-4">
                <ActionForm action={remindIt} submitLabel="Remind now" submitClass="btn-secondary">
                  <input type="hidden" name="id" value={env.id} />
                  <p className="text-xs text-gra-ink-2">Emails a fresh link to {turn.map((s) => s.name).join(", ") || "whoever is next"}.</p>
                </ActionForm>
                {!anySigned && !agreement && (
                  <ActionForm action={reviseIt} submitLabel="Revise the document" submitClass="btn-secondary" confirm="Take this back to draft to change it? The links already sent stop working and signers are told an updated version is coming.">
                    <input type="hidden" name="id" value={env.id} />
                    <p className="text-xs text-gra-ink-2">Nobody has signed yet, so you can still change it: back to draft to replace the PDF or adjust fields, then send it again as an amendment.</p>
                  </ActionForm>
                )}
                {anySigned && <p className="text-xs text-gra-ink-2">Someone has signed, so the document can&apos;t change. To make changes, void it and send a new document.</p>}
                <ActionForm action={extendIt} submitLabel="Extend" submitClass="btn-secondary" inline>
                  <input type="hidden" name="id" value={env.id} />
                  <input type="date" name="until" required className="input max-w-[11rem]" defaultValue={ymdIn(plusDays(env.expiresAt ?? t, 7), tz)} aria-label="New sign-by date" />
                </ActionForm>
                <ActionForm action={voidIt} submitLabel="Void" submitClass="btn-secondary text-rose-800" confirm="Void this document? Signers will be told and can't sign it any more.">
                  <input type="hidden" name="id" value={env.id} />
                  <input name="reason" required className="input" placeholder="Reason (signers will see it)" />
                </ActionForm>
                <details>
                  <summary className="cursor-pointer text-sm text-gra-deep">Signed on paper instead</summary>
                  <ActionForm action={paperIt} submitLabel="Upload the signed scan" submitClass="btn-secondary" className="mt-2" confirm="Mark as signed on paper? The scan becomes the final document and signing stops.">
                    <input type="hidden" name="id" value={env.id} />
                    <input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required className="input py-1.5" aria-label="Signed scan" />
                  </ActionForm>
                </details>
              </div>
            </Card>
          )}
          {manage && !agreement && !anySigned && env.status !== "COMPLETED" && (
            <Card title="Delete">
              <ActionForm action={deleteIt} submitLabel="Delete document" submitClass="btn-secondary text-rose-800" confirm="Delete this document, its file and its audit trail? This can't be undone.">
                <input type="hidden" name="id" value={env.id} />
                <p className="text-xs text-gra-ink-2">{ACTIVE.includes(env.status) ? "Nobody has signed yet. Signers are told it's cancelled, and the document is removed completely." : "Nobody signed it, so it can be removed completely."}</p>
              </ActionForm>
            </Card>
          )}
          {events.length > 0 && (
            <Card
              title="Audit trail"
              actions={
                <a className="btn-secondary text-xs" href={`/api/sign/audit/${env.id}`}>
                  PDF
                </a>
              }
            >
              <ol className="space-y-2 text-xs">
                {events.map((e) => (
                  <li key={e.id}>
                    <div className="font-medium text-gra-ink">
                      {e.type.replace(/_/g, " ").toLowerCase()} · {e.signerId ? names.get(e.signerId) : e.actorId ? (actors.get(e.actorId) ?? "a user") : "System"}
                    </div>
                    <div className="break-all text-gra-muted">
                      {when(e.at)}
                      {e.ip ? ` · ${e.ip}` : ""}
                      {e.details ? ` · ${e.details}` : ""}
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
