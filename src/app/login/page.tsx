import { appSettings } from "@/lib/settings";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; reauth?: string }> }) {
  const sp = await searchParams;
  const s = await appSettings();
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="rounded-lg border border-gra-hair bg-white p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo.png" alt={s.companyName} className="mx-auto mb-4 h-24 w-auto" />
        <p className="text-center text-[18px] font-light tracking-[3px] text-brandblue uppercase">{s.productName}</p>
        <h1 className="mt-1 text-center text-2xl font-bold">Sign in</h1>
        {sp.reauth && <p className="mt-2 text-sm text-gra-ink-2">To connect an app, confirm it&apos;s you with a fresh code.</p>}
        {sp.error && <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-900">{sp.error}</p>}
        <LoginForm next={sp.next ?? "/"} />
      </div>
      <p className="mt-4 text-center text-xs text-gra-muted">No password: we email you a 6-digit code.</p>
    </div>
  );
}
