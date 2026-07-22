/**
 * Funding-carry backtest over real Binance history.
 *
 * Answers "would harvesting funding carry have made money after costs?" without
 * waiting months for the live cron to build a record. Honest about scope: L1
 * single-venue carry only, delta-neutral so price cancels, modelled costs
 * charged in full. See `lib/backtest/carry.ts`.
 */

import { runCarryBacktest } from "@/lib/backtest/run";
import { readConfig } from "@/lib/engine/store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const points = Math.min(Math.max(Number(url.searchParams.get("points")) || 720, 60), 1000);

  const config = await readConfig();

  try {
    const result = await runCarryBacktest({
      minFundingApr: config.minFundingApr,
      minPositiveShare: config.minPositiveShare,
      regimeWindow: config.fundingRegimeWindow,
      expectedHoldDays: config.expectedHoldDays,
      minNetEdgeBps: config.minNetEdgeBps,
      points,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Backtest failed" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
