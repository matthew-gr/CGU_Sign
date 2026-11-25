import "./globals.css";
import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { currentUser, isAdmin } from "@/lib/session";
import { appSettings } from "@/lib/settings";
import { logout } from "@/lib/login-actions";

export async function generateMetadata() {
  const s = await appSettings();
  return { title: { default: `${s.productName} · ${s.companyName}`, template: `%s · ${s.productName}` }, robots: { index: false, follow: false } };
}

// Pages for people outside the company (signers, viewers, Verify) show no app navigation.
const BARE = /^\/(s|d)\/|^\/login|^\/verify$/;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const path = (await headers()).get("x-pathname") ?? "";
  const s = await appSettings();
  const bare = BARE.test(path);
  const me = bare ? null : await currentUser();
  return (
    <html lang="en">
      <body style={{ ["--brand" as string]: s.brandColor }}>
        <div className="tricolor" aria-hidden />
        {me && (
          <header className="border-b border-gra-hair bg-white">
            <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm" aria-label="Main">
              <Link href="/" className="font-semibold" style={{ color: s.brandColor }}>
                {s.companyName} · {s.productName}
              </Link>
              <Link href="/" className="text-gra-ink-2 hover:text-gra-ink">
                Agreements
              </Link>
              <Link href="/agreements/new" className="text-gra-ink-2 hover:text-gra-ink">
                New agreement
              </Link>
              <Link href="/envelopes" className="text-gra-ink-2 hover:text-gra-ink">
                Other documents
              </Link>
              {isAdmin(me) && (
                <>
                  <Link href="/templates" className="text-gra-ink-2 hover:text-gra-ink">
                    Templates
                  </Link>
                  <Link href="/settings" className="text-gra-ink-2 hover:text-gra-ink">
                    Settings
                  </Link>
                </>
              )}
              <span className="ml-auto flex items-center gap-4">
                <Link href="/account" className="text-gra-ink-2 hover:text-gra-ink">
                  {me.name}
                </Link>
                <form action={logout}>
                  <button className="text-gra-ink-2 hover:text-gra-ink">Sign out</button>
                </form>
              </span>
            </nav>
          </header>
        )}
        <main className={bare ? "" : "mx-auto max-w-6xl px-4 py-8"}>{children}</main>
      </body>
    </html>
  );
}
