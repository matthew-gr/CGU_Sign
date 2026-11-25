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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&family=Playfair+Display:wght@700;800&display=swap" />
      </head>
      <body style={{ ["--brand" as string]: s.brandColor }}>
        <div className="tricolor" aria-hidden />
        {me && (
          <header className="border-b border-gra-hair bg-[#f9f9f9] shadow-[0_12px_18px_-6px_rgba(0,0,0,0.12)]">
            <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm" aria-label="Main">
              <Link href="/" className="mr-2 flex items-center gap-3" aria-label={`${s.companyName} ${s.productName} home`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/logo.png" alt={s.companyName} className="h-14 w-auto" />
                <span className="hidden text-[13px] font-bold tracking-[4px] text-gra-ink-2 uppercase sm:inline">{s.productName}</span>
              </Link>
              <Link href="/" className="text-[13px] font-semibold tracking-wide text-gra-ink-2 uppercase hover:text-plum">
                Agreements
              </Link>
              <Link href="/agreements/new" className="text-[13px] font-semibold tracking-wide text-gra-ink-2 uppercase hover:text-plum">
                New agreement
              </Link>
              <Link href="/envelopes" className="text-[13px] font-semibold tracking-wide text-gra-ink-2 uppercase hover:text-plum">
                Uploaded documents
              </Link>
              {isAdmin(me) && (
                <>
                  <Link href="/templates" className="text-[13px] font-semibold tracking-wide text-gra-ink-2 uppercase hover:text-plum">
                    Templates
                  </Link>
                  <Link href="/settings" className="text-[13px] font-semibold tracking-wide text-gra-ink-2 uppercase hover:text-plum">
                    Settings
                  </Link>
                </>
              )}
              <span className="ml-auto flex items-center gap-4">
                <Link href="/account" className="text-[13px] font-semibold tracking-wide text-gra-ink-2 uppercase hover:text-plum">
                  {me.name}
                </Link>
                <form action={logout}>
                  <button className="text-[13px] font-semibold tracking-wide text-gra-ink-2 uppercase hover:text-plum">Sign out</button>
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
