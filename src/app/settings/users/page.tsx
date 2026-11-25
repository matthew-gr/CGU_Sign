import { requireAdmin } from "@/lib/session";
import { listUsers } from "@/lib/users";
import { inviteUserAction, removeUserAction, updateUserAction } from "@/lib/admin-actions";
import { ActionForm } from "@/components/ActionForm";
import { Card, PageTitle } from "@/components/ui";
import { SettingsNav } from "../SettingsNav";

export const dynamic = "force-dynamic";

export default async function Users() {
  const me = await requireAdmin();
  const users = await listUsers();
  return (
    <>
      <PageTitle title="Settings" />
      <SettingsNav at="/settings/users" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Users">
          <div className="space-y-3">
            {users.map((u) => (
              <div key={u.id} className="rounded-md border border-gra-hair p-3">
                <ActionForm action={updateUserAction} submitLabel="Save" submitClass="btn-secondary text-xs" inline keepValues>
                  <input type="hidden" name="id" value={u.id} />
                  <label>
                    <span className="label">Name</span>
                    <input name="name" className="input" defaultValue={u.name} />
                  </label>
                  <label>
                    <span className="label">Title</span>
                    <input name="title" className="input" defaultValue={u.title} />
                  </label>
                  <label>
                    <span className="label">Role</span>
                    <select name="role" className="input" defaultValue={u.role}>
                      <option value="SENDER">Sender</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  </label>
                </ActionForm>
                <div className="mt-2 flex items-center justify-between text-xs text-gra-ink-2">
                  <span>{u.email}</span>
                  {u.id !== me.id && (
                    <ActionForm action={removeUserAction} submitLabel="Remove" submitClass="text-xs text-rose-700 hover:underline" confirm={`Remove ${u.name}? Their sessions, connected apps and API keys end immediately.`} inline>
                      <input type="hidden" name="id" value={u.id} />
                    </ActionForm>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Invite someone">
          <ActionForm action={inviteUserAction} submitLabel="Invite">
            <label className="block">
              <span className="label">Email</span>
              <input name="email" type="email" className="input" required />
            </label>
            <label className="block">
              <span className="label">Name</span>
              <input name="name" className="input" required />
            </label>
            <label className="block">
              <span className="label">Title (optional)</span>
              <input name="title" className="input" />
            </label>
            <label className="block">
              <span className="label">Role</span>
              <select name="role" className="input" defaultValue="SENDER">
                <option value="SENDER">Sender: prepares and sends agreements, sees their own</option>
                <option value="ADMIN">Admin: everything, including templates, Airtable and users</option>
              </select>
            </label>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
