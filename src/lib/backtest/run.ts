/**
 * Running the carry backtest on real history.
 *
 * Pulls each asset's actual Binance funding-rate history, charges an honest
 * round-trip cost from the same cost model the live scanner uses, runs the
 * carry simulation, and combines the assets into an equal-weight portfolio.
 *
 * The funding series IS the data — for a delta-neutral carry the P&L is the
 * funding minus costs, so no price path is invented. Where an asset was listed
 * for only part of the window it simply has a shorter series; the portfolio
 * averages what is available.
 */

import { fetchBinanceFundingHistory } from "@/lib/market/venues";
import { roundTripCost, type LegSpec } from "@/lib/calc/costs";
import { UNIVERSE } from "@/lib/market/types";
import {
  backtestCarry,
  carryStats,
  INTERVALS_PER_YEAR_8H,
  type CarryBacktest,
  type CarryBacktestParams,
  type CarryStats,
  type FundingPoint,
} from "./carry";

export type BacktestConfig = {
  minFundingApr: number;
  minPositiveShare: number;
  regimeWindow: number;
  expectedHoldDays: number;
  minNetEdgeBps: number;
  /** How many 8-hour funding points to pull per asset (max ~1000 on Binance). */
  points: number;
};

export type BacktestResult = {
  params: CarryBacktestParams;
  points: number;
  periodDays: number;
  costFraction: number;
  portfolio: { equity: { t: number; cumReturn: number }[]; stats: CarryStats };
  byAsset: { asset: string; stats: CarryStats; points: number }[];
  caveats: string[];
};

/** Representative round-trip cost for a carry (Binance spot + perp), as a fraction of one leg's notional. */
function carryRoundTripFraction(legNotionalUsd = 1_000): number {
  const leg = (market: "spot" | "perp"): LegSpec => ({
    venue: "binance",
    market,
    liquidity: "taker",
    notionalUsd: legNotionalUsd,
    // Representative majors spread; the historical book depth is not recorded,
    // so a deep book with a small spread is assumed and the fee dominates.
    spreadBps: market === "spot" ? 2 : 3,
    depthUsd: 5_000_000,
  });
  const cost = roundTripCost([leg("spot"), leg("perp")]);
  // Cost is across both legs; the carry return is on ONE leg's notional, so the
  // comparable cost fraction is total cost over one leg.
  return cost.totalUsd / legNotionalUsd;
}

export async function runCarryBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const params: CarryBacktestParams = {
    minFundingApr: config.minFundingApr,
    minPositiveShare: config.minPositiveShare,
    regimeWindow: config.regimeWindow,
    roundTripCostFraction: carryRoundTripFraction(),
    expectedHoldDays: config.expectedHoldDays,
    minNetEdgeBps: config.minNetEdgeBps,
  };

  const settled = await Promise.allSettled(
    UNIVERSE.map((a) => fetchBinanceFundingHistory(a, config.points)),
  );

  const seriesByAsset: { asset: string; series: FundingPoint[] }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.length > 0) {
      seriesByAsset.push({
        asset: UNIVERSE[i],
        series: r.value.map((p) => ({ t: p.t, rate: p.rate, apr: p.apr })),
      });
    }
  });

  const byAsset = seriesByAsset.map(({ asset, series }) => {
    const bt = backtestCarry(series, params);
    return { asset, bt, stats: carryStats(bt), points: series.length };
  });

  // Equal-weight portfolio: average per-interval returns across assets, aligned
  // by index from the most recent point backwards (Binance funding times are
  // synchronised across assets, so index alignment is timestamp alignment).
  const maxLen = Math.max(0, ...byAsset.map((a) => a.bt.intervalReturns.length));
  const portReturns: number[] = [];
  const portEquity: { t: number; cumReturn: number }[] = [];
  const refTimes =
    byAsset.find((a) => a.bt.equity.length === maxLen)?.bt.equity.map((e) => e.t) ?? [];

  let cum = 0;
  for (let i = 0; i < maxLen; i++) {
    // Align from the end so assets with shorter histories contribute to the
    // recent intervals they actually cover.
    let sum = 0;
    let n = 0;
    for (const a of byAsset) {
      const off = a.bt.intervalReturns.length - maxLen + i;
      if (off >= 0) {
        sum += a.bt.intervalReturns[off];
        n += 1;
      }
    }
    const r = n > 0 ? sum / n : 0;
    portReturns.push(r);
    cum += r;
    portEquity.push({ t: refTimes[i] ?? i, cumReturn: cum });
  }

  const portComposite: CarryBacktest = {
    trades: byAsset.flatMap((a) => a.bt.trades),
    equity: portEquity,
    intervalReturns: portReturns,
    intervalsHeld:
      byAsset.length > 0
        ? byAsset.reduce((s, a) => s + a.bt.intervalsHeld / Math.max(a.bt.intervalsTotal, 1), 0) /
          byAsset.length *
          maxLen
        : 0,
    intervalsTotal: maxLen,
  };

  return {
    params,
    points: config.points,
    periodDays: (maxLen * 8) / 24,
    costFraction: params.roundTripCostFraction,
    portfolio: { equity: portEquity, stats: carryStats(portComposite) },
    byAsset: byAsset.map((a) => ({ asset: a.asset, stats: a.stats, points: a.points })),
    caveats: [
      "Single-venue funding carry (L1) only — not L2 cross-venue or FX carry.",
      "Delta-neutral: the price path cancels between legs, so P&L is funding minus costs.",
      "Round-trip cost is the modelled fee plus a representative spread, charged in full up front.",
      "Returns are on notional; leverage would raise return on capital by L/(L+1).",
      `Based on the last ${INTERVALS_PER_YEAR_8H > 0 ? Math.round((maxLen * 8) / 24) : 0} days of real Binance funding.`,
    ],
  };
}
