/**
 * Running the L2 spread backtest on real multi-venue history.
 *
 * Pulls funding history from Binance, Bybit and OKX, aligns each venue pair
 * per asset, and replays the cross-venue spread through the same economics the
 * live scanner uses. Its headline output is the exit-deadband sweep: the
 * evidence that decides where `EXIT_SPREAD_APR` in the live exit manager
 * should sit, rather than the cost arithmetic it was first derived from.
 */

import {
  fetchBinanceFundingHistory,
  fetchBybitFundingHistory,
  fetchOKXFundingHistory,
} from "@/lib/market/venues";
import { roundTripCost, type LegSpec } from "@/lib/calc/costs";
import { UNIVERSE } from "@/lib/market/types";
import { carryStats, type CarryStats } from "./carry";
import {
  alignSeries,
  backtestSpread,
  sweepExitDeadband,
  type SpreadBacktestParams,
  type SpreadPoint,
  type SweepPoint,
} from "./spread";

export type SpreadBacktestConfig = {
  minSpreadApr: number;
  minNetEdgeBps: number;
  expectedHoldDays: number;
  /** Funding intervals to pull per venue. */
  points: number;
  /** Trailing window for median confirmation; 0 disables. */
  regimeWindow?: number;
};

export type SpreadPairResult = {
  asset: string;
  venues: string;
  intervals: number;
  stats: CarryStats;
};

export type SpreadBacktestResult = {
  points: number;
  periodDays: number;
  costFraction: number;
  pairs: SpreadPairResult[];
  /** Exit-deadband sweep — the parameter evidence. */
  sweep: SweepPoint[];
  /** The deadband the sweep supports: best return, ties broken by fewer trades. */
  bestExitSpreadApr: number | null;
  /** What the live exit manager currently uses, for comparison. */
  liveExitSpreadApr: number;
  caveats: string[];
};

/** Round-trip cost for a two-perp-leg spread, as a fraction of one leg. */
function spreadRoundTripFraction(legNotionalUsd = 1_000): number {
  const leg = (venue: string): LegSpec => ({
    venue,
    market: "perp",
    liquidity: "taker",
    notionalUsd: legNotionalUsd,
    spreadBps: 3,
    depthUsd: 5_000_000,
  });
  const cost = roundTripCost([leg("binance"), leg("bybit")]);
  return cost.totalUsd / legNotionalUsd;
}

/** Candidate deadbands, from naive (0) out to a wide band. */
const CANDIDATES = [0, -0.005, -0.01, -0.02, -0.03, -0.05, -0.08, -0.12];

export async function runSpreadBacktest(
  config: SpreadBacktestConfig,
): Promise<SpreadBacktestResult> {
  const roundTripCostFraction = spreadRoundTripFraction();

  const params: Omit<SpreadBacktestParams, "exitSpreadApr"> = {
    minSpreadApr: config.minSpreadApr,
    minNetEdgeBps: config.minNetEdgeBps,
    roundTripCostFraction,
    expectedHoldDays: config.expectedHoldDays,
    regimeWindow: config.regimeWindow ?? 0,
  };

  // Pull all three venues for every asset, tolerating per-venue failure: a
  // venue that does not list an asset simply produces no pair for it.
  const settled = await Promise.allSettled(
    UNIVERSE.flatMap((asset) => [
      fetchBinanceFundingHistory(asset, config.points).then((r) => ({ asset, venue: "Binance", r })),
      fetchBybitFundingHistory(asset, config.points).then((r) => ({ asset, venue: "Bybit", r })),
      fetchOKXFundingHistory(asset, config.points).then((r) => ({ asset, venue: "OKX", r })),
    ]),
  );

  const byAssetVenue = new Map<string, { t: number; rate: number; apr: number }[]>();
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.r.length > 0) {
      byAssetVenue.set(`${s.value.asset}:${s.value.venue}`, s.value.r);
    }
  }

  // Every venue pairing per asset. Order within a pair does not matter — the
  // simulation picks its own direction at entry from the sign of the spread.
  const PAIRS: [string, string][] = [
    ["Binance", "Bybit"],
    ["Binance", "OKX"],
    ["Bybit", "OKX"],
  ];

  const pairs: SpreadPairResult[] = [];
  const seriesForSweep: SpreadPoint[][] = [];
  let maxIntervals = 0;

  for (const asset of UNIVERSE) {
    for (const [va, vb] of PAIRS) {
      const a = byAssetVenue.get(`${asset}:${va}`);
      const b = byAssetVenue.get(`${asset}:${vb}`);
      if (!a || !b) continue;

      const aligned = alignSeries(a, b);
      // Too short to say anything: skip rather than report noise as a result.
      if (aligned.length < 60) continue;

      maxIntervals = Math.max(maxIntervals, aligned.length);
      seriesForSweep.push(aligned);

      const bt = backtestSpread(aligned, { ...params, exitSpreadApr: 0 });
      pairs.push({
        asset,
        venues: `${va}⇄${vb}`,
        intervals: aligned.length,
        stats: carryStats(bt),
      });
    }
  }

  const sweep =
    seriesForSweep.length > 0
      ? sweepExitDeadband(seriesForSweep, params, CANDIDATES)
      : [];

  // Best band: highest total return; a tie goes to the one that traded less,
  // since fewer round trips means less exposure to cost-model error.
  let best: SweepPoint | null = null;
  for (const s of sweep) {
    if (
      best === null ||
      s.stats.totalReturnPct > best.stats.totalReturnPct ||
      (s.stats.totalReturnPct === best.stats.totalReturnPct && s.trades < best.trades)
    ) {
      best = s;
    }
  }

  return {
    points: config.points,
    periodDays: (maxIntervals * 8) / 24,
    costFraction: roundTripCostFraction,
    pairs: pairs.sort((x, y) => y.stats.totalReturnPct - x.stats.totalReturnPct),
    sweep,
    bestExitSpreadApr: best?.exitSpreadApr ?? null,
    liveExitSpreadApr: -0.02,
    caveats: [
      "Cross-venue funding spread (L2) only — both legs perps, no spot leg.",
      "Price largely cancels between legs; basis drift between venue marks is ignored.",
      "Round-trip cost across both perp legs, charged in full up front.",
      "Margin cost of holding two perp positions rather than one is not modelled.",
      "Returns are on one leg's notional; leverage would raise return on capital.",
      "Venue pairs with fewer than 60 aligned intervals are excluded, not padded.",
    ],
  };
}
