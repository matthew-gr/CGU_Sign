// Calling a server action from the browser. Our actions catch their own errors and return { error }, but the request
// can still fail on the way: no connection, the firewall in front of the site answering instead of the app (Cloudflare's
// 403 page), or a page opened before the last deploy. Next throws then, and a throw inside a transition takes down the
// whole page ("Application error: a client-side exception"). callAction turns those into an { error } the form shows.
import { unstable_isUnrecognizedActionError, unstable_rethrow } from "next/navigation";

export async function callAction<R extends { error?: string }>(action: () => Promise<R>): Promise<R> {
  try {
    return await action();
  } catch (e) {
    unstable_rethrow(e); // Next's own control flow (a redirect from the action) must carry on.
    console.error("Server action failed:", e); // Kept in the browser console for whoever looks into it.
    return { error: actionFailure(e) } as R;
  }
}

/** What to tell someone when an action never sent back a result. */
export function actionFailure(e: unknown): string {
  if (unstable_isUnrecognizedActionError(e)) return "The app was updated after you opened this page. Reload the page and try again.";
  const msg = e instanceof Error ? e.message : String(e);
  // fetch's wording for a dropped connection: Chrome, Safari, Firefox.
  if (/failed to fetch|load failed|networkerror/i.test(msg)) return "Couldn't reach the server. Check your internet connection and try again.";
  return "That didn't go through. Reload the page to see what was saved, then try again. If it keeps happening, tell your administrator what you were doing and when.";
}
