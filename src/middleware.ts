import { NextResponse, type NextRequest } from "next/server";

// Pages without a session cookie go to /login. The cookie itself is checked against the database by getActor() on
// every page and action (the middleware runs at the edge and can't read the database).
//
// Public by design: the login flow; signers' and viewers' pages (a signed single-use link plus an emailed code) and
// their PDF and the PDF worker; the Verify page; the MCP endpoint (it checks its own bearer token), OAuth discovery,
// registration, token and revoke; the daily job (secret header); health.
export const PUBLIC = [
  /^\/login(\/.*)?$/,
  /^\/api\/login(\/.*)?$/,
  /^\/s\/[\w.-]+$/,
  /^\/d\/[\w.-]+(\/download)?$/,
  /^\/verify$/,
  /^\/api\/sign\/(signer-file|pdf-worker)$/,
  /^\/mcp$/,
  /^\/mcp\/health$/,
  /^\/\.well-known\/(oauth-protected-resource(\/mcp)?|oauth-authorization-server)$/,
  /^\/api\/oauth\/(register|token|revoke)$/,
  /^\/api\/cron\/daily$/,
  /^\/api\/health$/,
  // Short-lived signed file links from MCP tools; without exp/sig the route itself requires a session.
  /^\/api\/agreements\/\w+\/file$/,
  /^\/fonts\/[\w.-]+$/,
];

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (!PUBLIC.some((re) => re.test(path)) && !req.cookies.get("as_session")?.value) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = path === "/" ? "" : `?next=${encodeURIComponent(path + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  const headers = new Headers(req.headers);
  headers.set("x-pathname", path);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "same-origin");
  res.headers.set("X-Content-Type-Options", "nosniff");
  return res;
}

export const config = { matcher: ["/((?!_next|favicon|icon|apple-icon|brand/).*)"] };
