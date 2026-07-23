/**
 * Cross-venue spread (L2) backtest over real multi-venue funding history.
 *
 * This is the route that answered "should we be trading L2 at all?" — and the
 * answer was no at retail taker cost. It stays live so the finding is
 * reproducible rather than a claim in a commit message, and so it re-answers
 * itself if venue funding ever behaves differently.
 */

import { runSpreadBacktest } from "@/lib/backtest/runspread";
import { readConfig } from "@/lib/engine/store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const points = Math.min(Math.max(Number(url.searchParams.get("points")) || 600, 120), 1000);

  const config = await readConfig();

  try {
    const result = await runSpreadBacktest({
      minSpreadApr: config.minFundingApr,
      minNetEdgeBps: config.minNetEdgeBps,
      expectedHoldDays: config.expectedHoldDays,
      points,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Spread backtest failed" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
