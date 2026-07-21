/**
 * Site lock — a shared-password gate.
 *
 * **Be clear about what this is.** It is a deterrent that keeps the dashboard
 * off the open internet: one shared password, no accounts, no per-person
 * identity. It is not authentication and nothing in the system should ever
 * treat it as proof of who is acting. When real sessions arrive, attribution
 * comes from those — see the note in `fund/fund.ts` about why unverified
 * attribution is worse than none.
 *
 * What it does get right:
 *   - The password is checked **server-side**. A client-side comparison would
 *     ship the password to every visitor in the bundle, which is not a lock,
 *     it is a label saying "locked".
 *   - The cookie is a **signed token**, not a boolean. `authed=true` in a
 *     cookie is forgeable by anyone who opens devtools.
 *   - Tokens **expire**, so a leaked cookie is not permanent access.
 *   - Signing uses Web Crypto, which works in both the Edge runtime (where the
 *     proxy runs) and Node (where the API route runs). `node:crypto` is
 *     unavailable in Edge, and discovering that at deploy time is a bad way to
 *     find out the lock does not work.
 */

const COOKIE_NAME = "mg_session";
const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export { COOKIE_NAME };

export function sitePassword(): string | null {
  const p = process.env.SITE_PASSWORD;
  return p && p.length > 0 ? p : null;
}

/**
 * Whether the lock is configured.
 *
 * When it is not, the site stays **locked** rather than falling open. A missing
 * environment variable is the most likely way this gets misconfigured, and
 * failing open would silently publish the dashboard — the exact outcome the
 * lock exists to prevent.
 */
export function lockConfigured(): boolean {
  return sitePassword() !== null;
}

async function hmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison.
 *
 * Both inputs here are HMACs of a secret an attacker does not hold, so the
 * practical risk is slight — but a comparison that returns early on the first
 * differing character is a habit worth not having in code that gates access.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Issue a session token.
 *
 * Signed with the password itself, so changing the password invalidates every
 * existing session. That is the behaviour you want: rotating the password
 * should actually revoke access, not merely change what the next person types.
 */
export async function issueToken(password: string): Promise<string> {
  const expiry = String(Date.now() + TTL_MS);
  return `${expiry}.${await hmac(password, expiry)}`;
}

export async function verifyToken(token: string | undefined): Promise<boolean> {
  const secret = sitePassword();
  if (!secret || !token) return false;

  const [expiry, signature] = token.split(".");
  if (!expiry || !signature) return false;

  const expiryMs = Number(expiry);
  if (!Number.isFinite(expiryMs) || Date.now() > expiryMs) return false;

  return safeEqual(signature, await hmac(secret, expiry));
}

/** Constant-time check of a submitted password. */
export async function checkPassword(submitted: string): Promise<boolean> {
  const secret = sitePassword();
  if (!secret) return false;
  // Compared as HMACs so the check does not leak length or prefix through
  // timing, and so a wrong password of a different length costs the same.
  const [a, b] = await Promise.all([hmac(secret, "check"), hmac(submitted, "check")]);
  return safeEqual(a, b);
}

export const SESSION_TTL_MS = TTL_MS;
