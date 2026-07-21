/**
 * Site lock.
 *
 * Next 16 renamed Middleware to **Proxy**; the file must be `proxy.ts` beside
 * `app/`. A `middleware.ts` here would be ignored entirely — the site would
 * look locked and be wide open, which is the worst possible failure for this
 * particular file.
 *
 * Everything is gated except the login screen, the auth endpoint, and static
 * assets. **API routes are gated too** — locking only the pages would leave
 * every balance, position and configuration readable by anyone who guessed a
 * URL, which is not a lock at all.
 */

import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, verifyToken } from "@/lib/auth/session";

export const config = {
  /**
   * Everything except Next's own assets and the public files.
   *
   * `/login` and `/api/auth` are matched by this pattern and allowed through in
   * code rather than excluded here, so the allowlist lives in one obvious place
   * instead of being split between a regex and a branch.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg).*)"],
};

/**
 * Paths the site lock does not gate.
 *
 * `/api/cron/*` is here because a scheduled invocation has no browser and no
 * cookie. It is not unprotected — it enforces its own bearer-token check, and
 * refuses to run at all when CRON_SECRET is unset.
 */
const PUBLIC_PATHS = new Set(["/login", "/api/auth"]);
const PUBLIC_PREFIXES = ["/api/cron/"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (await verifyToken(token)) return NextResponse.next();

  // An unauthenticated API call gets 401 JSON rather than an HTML redirect,
  // so a polling client fails cleanly instead of parsing a login page as data.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Locked. Sign in at /login." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  // Carry the destination so signing in lands where the visitor was headed.
  url.searchParams.set("next", pathname === "/" ? "/" : pathname);
  return NextResponse.redirect(url);
}
