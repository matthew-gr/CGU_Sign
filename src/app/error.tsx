"use client";

// Any error a page throws in the browser lands here, inside the normal header and navigation, instead of Next's bare
// "Application error: a client-side exception has occurred" screen.
export default function PageError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md pt-10">
      <div className="rounded-2xl bg-white px-8 py-9 text-center shadow-[0_1px_2px_rgba(0,0,0,.04),0_6px_16px_rgba(0,0,0,.05)]">
        <h1 className="font-display text-2xl font-semibold text-gra-deep">Something went wrong on this page</h1>
        <p className="mt-2 text-sm text-gra-ink-2">Reload the page to see what was saved, then try again. If it keeps happening, note what you were doing and when, and let your support contact know.</p>
        {/* Reload rather than reset(): a page opened before the last deploy needs the new code. */}
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
  );
}
