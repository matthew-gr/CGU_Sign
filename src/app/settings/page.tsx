import { requireAdmin } from "@/lib/session";
import { appSettings, currentConsent } from "@/lib/settings";
import { saveCompanySettings, saveConsent } from "@/lib/admin-actions";
import { ActionForm } from "@/components/ActionForm";
import { Card, Notice, PageTitle } from "@/components/ui";
import { SettingsNav } from "./SettingsNav";

export const dynamic = "force-dynamic";

export default async function Settings() {
  await requireAdmin();
  const s = await appSettings();
  const consent = currentConsent(s);
  return (
    <>
      <PageTitle title="Settings" />
      <SettingsNav at="/settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Company">
          <ActionForm action={saveCompanySettings} submitLabel="Save" keepValues>
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                <span className="label">Company name</span>
                <input name="companyName" className="input" defaultValue={s.companyName} required />
              </label>
              <label>
                <span className="label">App name</span>
                <input name="productName" className="input" defaultValue={s.productName} />
              </label>
              <label>
                <span className="label">Email sender name</span>
                <input name="senderName" className="input" defaultValue={s.senderName} />
              </label>
              <label>
                <span className="label">Reply-to address</span>
                <input name="replyTo" type="email" className="input" defaultValue={s.replyTo} />
              </label>
              <label className="sm:col-span-2">
                <span className="label">Logo URL (https, shown in emails)</span>
                <input name="logoUrl" className="input" defaultValue={s.logoUrl} />
              </label>
              <label>
                <span className="label">Brand color</span>
                <input name="brandColor" className="input" defaultValue={s.brandColor} />
              </label>
              <label>
                <span className="label">Time zone</span>
                <input name="timeZone" className="input" defaultValue={s.timeZone} list="zones" />
                <datalist id="zones">
                  {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </label>
              <label>
                <span className="label">Default sign-by (days)</span>
                <input name="expiryDays" type="number" min={1} max={90} className="input" defaultValue={s.expiryDays} />
              </label>
              <label>
                <span className="label">Keep records for (years)</span>
                <input name="retentionYears" type="number" min={1} max={30} className="input" defaultValue={s.retentionYears} />
              </label>
              <label>
                <span className="label">Reference prefix</span>
                <input name="referencePrefix" className="input" defaultValue={s.referencePrefix} />
              </label>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name="dailyReminders" defaultChecked={s.dailyReminders} /> Remind signers daily when an agreement has been waiting 3+ days
              </label>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name="attachFinalPdf" defaultChecked={s.attachFinalPdf} /> Attach the signed PDF to the completion email
              </label>
            </div>
          </ActionForm>
        </Card>
        <Card title={`Consent to electronic records (version ${consent.version})`}>
          <div className="mb-3">
            <Notice tone="warn">Your attorney should approve this text before going live (ESIGN §101(c), UETA). Each change is saved as a new version; every signature keeps the text and version its signer accepted.</Notice>
          </div>
          <ActionForm action={saveConsent} submitLabel="Save as a new version" keepValues>
            <textarea name="consentText" className="input" rows={14} defaultValue={consent.text} />
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
