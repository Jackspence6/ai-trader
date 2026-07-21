/**
 * Scheduled trading pass, for the deployment.
 *
 * The loop in `scripts/trade.ts` runs on a machine you control. This is the
 * same pass, invoked on a schedule by Vercel Cron, so the deployed system
 * trades even when nothing local is awake.
 *
 * **Authorisation is separate from the site lock.** The lock is a shared
 * password for humans with a browser; a cron invocation has neither. Vercel
 * sends `Authorization: Bearer $CRON_SECRET` when that variable is set, and
 * this route requires it. Leaving the endpoint open would let anyone on the
 * internet trigger trading passes at will.
 *
 * Fails closed: with `CRON_SECRET` unset the route refuses every request
 * rather than running unauthenticated.
 */

import { runTradingPass } from "@/lib/engine/pass";

/**
 * Paper passes take several seconds — a market snapshot across three venues
 * plus funding history for eight assets. The default serverless timeout is
 * shorter than that on some plans.
 */
export const maxDuration = 60;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return Response.json(
      {
        error: process.env.CRON_SECRET
          ? "Unauthorised"
          : "CRON_SECRET is not set. The endpoint refuses to run rather than accept unauthenticated requests.",
      },
      { status: 401 },
    );
  }

  try {
    const { record, summary } = await runTradingPass();
    return Response.json(
      {
        ok: true,
        summary,
        ts: record.ts,
        scored: record.scored,
        executed: record.executed,
        navAfter: record.navAfter,
        skipped: record.skipped,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    // A failed pass returns 500 so the platform records it as a failed
    // invocation rather than a silent success.
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
