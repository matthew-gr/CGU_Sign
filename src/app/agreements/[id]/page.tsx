import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getActor } from "@/lib/session";
import { appSettings } from "@/lib/settings";
import { dateShort, dateTime, ymdIn } from "@/lib/tz";
import * as A from "@/lib/agreements/core";
import { versionFull } from "@/lib/templates/core";
import { writeState } from "@/lib/airtable/writeback";
import { currentTurn, ACTIVE } from "@/lib/sign/core";
import { Card, Notice, PageTitle, StatusBadge } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { CopyLink } from "@/components/sign/CopyLink";
import { deleteAction, extendAction, paperAction, refreshAction, remindAction, reviseAction, voidAction } from "@/lib/agreements/actions";
import { FillForm } from "./FillForm";
import { SendPanel } from "./SendPanel";

export const dynamic = "force-dynamic";

const SOURCE_TEXT: Record<string, string> = { AIRTABLE: "Airtable", FIXED: "Fixed", DEFAULT: "Default", TYPED: "Typed", OVERRIDE: "Changed" };

export default async function AgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getActor();
  let a;
  try {
    a = await A.load(me, id);
  } catch {
    notFound();
  }
  const v = await versionFull(a.templateVersionId);
  const s = await appSettings();
  const tz = s.timeZone;
  const { fields, switches } = A.fieldViews(v, a);
  const missing = A.missingOf(v, a);
  const parties = A.partiesOf(a);
  const env = a.envelopeId ? await db.signEnvelope.findUnique({ where: { id: a.envelopeId } }) : null;
  const signers = env ? await db.signSigner.findMany({ where: { envelopeId: env.id }, orderBy: { order: "asc" } }) : [];
  const events = env ? await db.signEvent.findMany({ where: { envelopeId: env.id }, orderBy: [{ at: "desc" }, { id: "desc" }], take: 100 }) : [];
  const users = new Map((await db.user.findMany({ where: { id: { in: [...events.map((e) => e.actorId).filter((x): x is string => !!x), a.ownerId] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const signerNames = new Map(signers.map((x) => [x.id, x.name]));
  const wb = await writeState(a.id);
  const draft = a.status === "DRAFT";
  const active = env && ACTIVE.includes(env.status);
  const turn = env && active ? currentTurn(env, signers) : [];
  const anySigned = signers.some((x) => x.status === "SIGNED");
  const defaultSignBy = ymdIn(new Date(Date.now() + s.expiryDays * 86_400_000), tz);

  return (
    <>
      <PageTitle
        title={a.title}
        subtitle={
          <>
            <span className="font-mono">{a.reference}</span> · {v.template.name} v{v.version} · lead: {a.leadLabel} · owner: {users.get(a.ownerId) ?? "removed user"}
          </>
        }
        actions={<StatusBadge status={a.status} />}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {draft ? (
            <>
              {env?.sentAt && <Notice tone="warn">This agreement was taken back to revise. Signers were told the earlier link no longer works. Change what you need, then send it again: it goes out as an updated version.</Notice>}
              <Card
                title="Fill in the agreement"
                actions={
                  <ActionForm action={refreshAction} submitLabel="Refresh from Airtable" submitClass="btn-secondary text-xs" inline>
                    <input type="hidden" name="id" value={a.id} />
                  </ActionForm>
                }
              >
                <FillForm
                  id={a.id}
                  fields={fields.map((f) => ({ ...f, sourceText: SOURCE_TEXT[f.source] ?? f.source, originalDisplay: f.original !== undefined && f.original !== null ? String(f.original) : "" }))}
                  switches={switches}
                  parties={parties}
                />
              </Card>
            </>
          ) : (
            <Card title="Values used">
              <p className="mb-3 text-xs text-gra-ink-2">Frozen when the agreement was sent{a.frozenAt ? ` (${dateTime(a.frozenAt, tz)})` : ""}. Airtable changes after that don&apos;t affect it.</p>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {fields
                  .filter((f) => f.needed)
                  .map((f) => (
                    <div key={f.tag}>
                      <dt className="text-xs text-gra-muted">
                        {f.label} · {SOURCE_TEXT[f.source] ?? f.source}
                        {f.source === "AIRTABLE" || f.source === "OVERRIDE" ? ` (${f.airtableField})` : ""}
                      </dt>
                      <dd className="whitespace-pre-line">{f.display || "-"}</dd>
                    </div>
                  ))}
                {switches.map((x) => (
                  <div key={x.tag}>
                    <dt className="text-xs text-gra-muted">{x.label}</dt>
                    <dd>{x.on ? "Yes" : "No"}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
          <Card
            title={draft ? "Preview" : a.status === "COMPLETED" ? "Signed document" : "Document"}
            actions={
              <a className="link text-sm" href={`/api/agreements/${a.id}/file?kind=${draft ? "preview" : "signed"}`} target="_blank" rel="noreferrer">
                Open in a new tab
              </a>
            }
          >
            {draft && missing.length ? (
              <p className="text-sm text-gra-ink-2">The preview shows empty spaces where values are still missing.</p>
            ) : null}
            <iframe src={`/api/agreements/${a.id}/file?kind=${draft ? "preview" : "signed"}`} title="Agreement PDF" className="mt-2 h-[70vh] w-full rounded-md border border-gra-hair bg-gra-page" />
            {a.docxKey && (
              <p className="mt-2 text-xs">
                <a className="link" href={`/api/agreements/${a.id}/file?kind=docx`}>
                  Download the filled Word file
                </a>
              </p>
            )}
          </Card>
          {env && (
            <Card title="Audit trail" actions={<a className="link text-sm" href={`/api/sign/audit/${env.id}`}>Download PDF</a>}>
              <ul className="space-y-2 text-xs">
                {events.map((e) => (
                  <li key={e.id}>
                    <div className="font-medium">
                      {e.type.replace(/_/g, " ").toLowerCase()} · {e.signerId ? signerNames.get(e.signerId) : e.actorId ? users.get(e.actorId) : "System"}
                    </div>
                    <div className="break-all text-gra-muted">
                      {dateTime(e.at, tz)}
                      {e.ip ? ` · ${e.ip}` : ""}
                      {e.details ? ` · ${e.details}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {draft ? (
            <Card title="Send for signature">
              <SendPanel id={a.id} missing={missing} parties={parties} defaultOrder={v.signingOrder as "SEQUENTIAL" | "PARALLEL"} defaultSignBy={defaultSignBy} />
            </Card>
          ) : (
            <Card title="Signers">
              <ul className="space-y-3 text-sm">
                {signers.map((x) => (
                  <li key={x.id}>
                    <div className="font-medium">
                      {x.order}. {x.name} <span className="text-gra-ink-2">({x.role || "Signer"})</span>
                    </div>
                    <div className="text-xs text-gra-ink-2">{x.email}</div>
                    <div className="text-xs">
                      {x.status === "SIGNED" ? `Signed ${dateTime(x.signedAt, tz)}` : x.status === "DECLINED" ? `Declined: ${x.declineReason}` : x.viewedAt ? `Viewed ${dateTime(x.viewedAt, tz)}` : x.status === "WAITING" ? "Waiting for their turn" : "Email sent"}
                    </div>
                    {active && turn.some((t) => t.id === x.id) && <CopyLink signerId={x.id} />}
                  </li>
                ))}
              </ul>
              {env?.expiresAt && active && <p className="mt-3 text-xs text-gra-ink-2">Sign by {dateShort(env.expiresAt, tz)}</p>}
              {env?.status === "COMPLETED" && (
                <p className="mt-3 text-xs break-all text-gra-ink-2">
                  Completed {dateTime(env.completedAt, tz)}. SHA-256 <span className="font-mono">{env.finalHash}</span>. {env.certNote}
                </p>
              )}
              {env?.reason && <p className="mt-3 text-xs text-gra-ink-2">Reason: {env.reason}</p>}
            </Card>
          )}

          {wb && (
            <Card title="Airtable">
              {wb.done ? (
                <p className="text-sm text-emerald-800">Status written to Airtable.</p>
              ) : wb.gaveUp ? (
                <Notice tone="error">Couldn&apos;t write the status to Airtable after {wb.attempts} tries: {wb.error}. Signing isn&apos;t affected.</Notice>
              ) : (
                <Notice tone="warn">
                  Writing the status to Airtable{wb.attempts ? ` failed (${wb.error}); retrying${wb.nextAt ? ` at ${dateTime(wb.nextAt, tz)}` : ""}` : " is queued"}. Signing isn&apos;t affected.
                </Notice>
              )}
            </Card>
          )}

          {active && (
            <Card title="While it's out for signature">
              <div className="space-y-4">
                <ActionForm action={remindAction} submitLabel="Remind now" submitClass="btn-secondary">
                  <input type="hidden" name="id" value={a.id} />
                  <p className="text-xs text-gra-ink-2">Emails a fresh link to {turn.map((t) => t.name).join(", ") || "whoever is next"}.</p>
                </ActionForm>
                <ActionForm action={extendAction} submitLabel="Extend" submitClass="btn-secondary" inline>
                  <input type="hidden" name="id" value={a.id} />
                  <label>
                    <span className="label">New sign-by date</span>
                    <input type="date" name="until" className="input" required />
                  </label>
                </ActionForm>
                {!anySigned && (
                  <ActionForm action={reviseAction} submitLabel="Revise" submitClass="btn-secondary" confirm="Take it back to change it? Signers are told their link no longer works.">
                    <input type="hidden" name="id" value={a.id} />
                    <p className="text-xs text-gra-ink-2">Nobody has signed yet, so you can still change it.</p>
                  </ActionForm>
                )}
                <details>
                  <summary className="cursor-pointer text-sm">Signed on paper instead</summary>
                  <ActionForm action={paperAction} submitLabel="Upload the signed scan" submitClass="btn-secondary" className="mt-2">
                    <input type="hidden" name="id" value={a.id} />
                    <input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required className="text-sm" />
                  </ActionForm>
                </details>
              </div>
            </Card>
          )}

          {(draft || active) && (
            <Card title={draft && !env ? "Discard" : "Cancel"}>
              <div className="space-y-4">
                {active && (
                  <ActionForm action={voidAction} submitLabel="Void" submitClass="btn-danger">
                    <input type="hidden" name="id" value={a.id} />
                    <label className="block">
                      <span className="label">Reason (signers will see it)</span>
                      <input name="reason" className="input" required minLength={3} />
                    </label>
                  </ActionForm>
                )}
                {!anySigned && (
                  <ActionForm action={deleteAction} submitLabel="Delete" submitClass="btn-secondary text-rose-700" confirm="Delete this agreement completely? This can't be undone.">
                    <input type="hidden" name="id" value={a.id} />
                    <p className="text-xs text-gra-ink-2">{active ? "Signers are told it's cancelled, and it's removed completely." : "Removes the draft."}</p>
                  </ActionForm>
                )}
              </div>
            </Card>
          )}
          <p className="text-xs text-gra-muted">
            <Link className="link" href="/">
              Back to agreements
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
