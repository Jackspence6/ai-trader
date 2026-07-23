/**
 * Automated re-validation verdicts — every strategy's latest graded backtest.
 *
 * GET returns the latest snapshot and recent history; POST forces a run now
 * (the loop otherwise re-runs twice a day). The Research and Strategies pages
 * render this — health states, deltas and alerts all come from here.
 */

import {
  readResearchState,
  runResearchPass,
  REVALIDATE_INTERVAL_MS,
} from "@/lib/research/revalidate";

export async function GET() {
  const state = await readResearchState();
  return Response.json(
    { ...state, intervalMs: REVALIDATE_INTERVAL_MS },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST() {
  try {
    const snapshot = await runResearchPass();
    return Response.json({ snapshot }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Re-validation failed" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
