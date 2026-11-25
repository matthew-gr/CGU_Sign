"use client";

import "./globals.css";

// Errors in the root layout itself (src/app/error.tsx covers pages). This replaces the whole document, so it has its
// own <html> and <body>.
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="mx-auto max-w-md px-6 pt-16">
          <div className="rounded-2xl bg-white px-8 py-9 text-center shadow-[0_1px_2px_rgba(0,0,0,.04),0_6px_16px_rgba(0,0,0,.05)]">
            <h1 className="font-display text-2xl font-semibold text-gra-deep">Something went wrong</h1>
            <p className="mt-2 text-sm text-gra-ink-2">Reload the page and try again. If it keeps happening, note what you were doing and when, and let your support contact know.</p>
            <div className="mt-6 flex justify-center gap-2">
              <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
                Reload page
              </button>
              <a href="/" className="btn-secondary">
                Home
              </a>
            </div>
            {error.digest && <p className="mt-4 text-xs text-gra-muted">Reference: {error.digest}</p>}
          </div>
        </div>
      </body>
    </html>
  );
}
