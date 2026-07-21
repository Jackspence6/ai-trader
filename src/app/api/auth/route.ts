/**
 * Sign in and out of the site lock.
 *
 * The password is compared here, on the server. It is never sent to the client
 * and never appears in the bundle.
 */

import {
  checkPassword,
  COOKIE_NAME,
  issueToken,
  lockConfigured,
  sitePassword,
  SESSION_TTL_MS,
} from "@/lib/auth/session";

/** Whether the lock is configured — so the login screen can say so. */
export async function GET() {
  return Response.json(
    { configured: lockConfigured() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!lockConfigured()) {
    return Response.json(
      {
        error:
          "SITE_PASSWORD is not set on this deployment. The site stays locked until it is — failing open would publish the dashboard.",
      },
      { status: 503 },
    );
  }

  let body: { password?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const ok = await checkPassword(String(body.password ?? ""));

  if (!ok) {
    // A small delay blunts rapid guessing without needing shared rate-limit
    // state, which a serverless deployment has nowhere convenient to keep.
    await new Promise((r) => setTimeout(r, 600));
    return Response.json({ error: "Incorrect password" }, { status: 401 });
  }

  const token = await issueToken(sitePassword()!);
  const res = Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });

  res.headers.append(
    "set-cookie",
    [
      `${COOKIE_NAME}=${token}`,
      "Path=/",
      // HttpOnly: script on the page cannot read it, so an XSS bug cannot
      // exfiltrate the session.
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      // Secure in production only — a Secure cookie is dropped over plain
      // http, which would make local development impossible to sign into.
      process.env.NODE_ENV === "production" ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; "),
  );

  return res;
}

/** Sign out. */
export async function DELETE() {
  const res = Response.json({ ok: true });
  res.headers.append(
    "set-cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return res;
}
