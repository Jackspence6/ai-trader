/**
 * Running the FX backtests on real multi-year history.
 *
 * Pulls ~3 years of ECB daily fixes per pair (one free Frankfurter call each)
 * and replays both FX strategies through the live signal and cost code. Also
 * runs the F2 parameter-sensitivity grid: a strategy that only works at one
 * exact MA setting is overfit (DESIGN.md §8.8), so the live parameters are
 * judged by the stability of their neighbourhood, not by their own cell.
 */

import { FX_PAIRS, carryApr, fetchFxHistory } from "@/lib/market/forex";
import { DEFAULT_SWAP_MARKUP_APR } from "@/lib/calc/fxsignal";
import { STOP_LOSS_PCT } from "@/lib/oms/exits";
import { roundTripCost } from "@/lib/calc/costs";
import { fxSpreadBps, FX_VENUE } from "@/lib/market/fxbook";
import { carryStats, type CarryStats } from "./carry";
import {
  backtestFxCarry,
  backtestFxTrend,
  FX_INTERVALS_PER_YEAR,
  type FxCarryExtra,
  type FxDaily,
  type FxTrendExtra,
} from "./fx";

export type FxBacktestConfig = {
  /** Calendar days of history to pull. */
  days: number;
};

export type FxPairTrendResult = {
  symbol: string;
  stats: CarryStats;
  extra: FxTrendExtra;
};

export type FxPairCarryResult = {
  symbol: string;
  stats: CarryStats;
  extra: FxCarryExtra;
};

export type SensitivityCell = {
  fast: number;
  slow: number;
  minStrengthPct: number;
  totalReturnPct: number;
  trades: number;
};

export type FxBacktestResult = {
  days: number;
  periodDays: number;
  trend: {
    portfolio: CarryStats;
    priceReturn: number;
    carryReturn: number;
    pairs: FxPairTrendResult[];
    sensitivity: SensitivityCell[];
    /** The live parameters, so the UI can highlight their cell. */
    liveParams: { fast: number; slow: number; minStrengthPct: number };
  };
  carry: {
    portfolio: CarryStats;
    priceReturn: number;
    carryReturn: number;
    pairs: FxPairCarryResult[];
  };
  caveats: string[];
};

/** Round-trip cost fraction for one pair's spot leg under the live cost model. */
function fxRoundTripFraction(symbol: string, notionalUsd = 1_000): number {
  const cost = roundTripCost([
    {
      venue: FX_VENUE,
      market: "spot",
      liquidity: "taker",
      notionalUsd,
      spreadBps: fxSpreadBps(symbol),
      depthUsd: 5_000_000,
    },
  ]);
  return cost.totalUsd / notionalUsd;
}

/** Equal-weight portfolio stats from per-pair interval returns. */
function portfolioOf(
  runs: { intervalReturns: number[]; equity: { t: number }[] }[],
  fullRuns: ReturnType<typeof backtestFxTrend>["bt"][],
): CarryStats {
  const maxLen = Math.max(0, ...runs.map((r) => r.intervalReturns.length));
  const returns: number[] = [];
  const equity: { t: number; cumReturn: number }[] = [];
  const refTimes =
    runs.find((r) => r.equity.length === maxLen)?.equity.map((e) => e.t) ?? [];

  let cum = 0;
  for (let i = 0; i < maxLen; i++) {
    let sum = 0;
    let n = 0;
    for (const r of runs) {
      const off = r.intervalReturns.length - maxLen + i;
      if (off >= 0) {
        sum += r.intervalReturns[off];
        n += 1;
      }
    }
    const v = n > 0 ? sum / n : 0;
    returns.push(v);
    cum += v;
    equity.push({ t: refTimes[i] ?? i, cumReturn: cum });
  }

  return carryStats(
    {
      trades: fullRuns.flatMap((r) => r.trades),
      equity,
      intervalReturns: returns,
      intervalsHeld:
        fullRuns.length > 0
          ? (fullRuns.reduce(
              (s, r) => s + r.intervalsHeld / Math.max(r.intervalsTotal, 1),
              0,
            ) /
              fullRuns.length) *
            maxLen
          : 0,
      intervalsTotal: maxLen,
    },
    FX_INTERVALS_PER_YEAR,
  );
}

/** The live F2 parameters (evaluateFxTrend defaults). */
const LIVE_TREND = { fast: 20, slow: 60, minStrengthPct: 0.003 };

/** The sensitivity grid around them. */
const GRID: { fast: number; slow: number }[] = [
  { fast: 10, slow: 30 },
  { fast: 20, slow: 60 },
  { fast: 30, slow: 90 },
  { fast: 40, slow: 120 },
];
const STRENGTHS = [0.002, 0.003, 0.005];

export async function runFxBacktest(config: FxBacktestConfig): Promise<FxBacktestResult> {
  const settled = await Promise.allSettled(
    FX_PAIRS.map(async (p) => ({
      symbol: p.symbol,
      base: p.base,
      quote: p.quote,
      series: (await fetchFxHistory(p.symbol, config.days)) as FxDaily[],
    })),
  );

  const pairs = settled
    .filter((s): s is PromiseFulfilledResult<{
      symbol: string;
      base: string;
      quote: string;
      series: FxDaily[];
    }> => s.status === "fulfilled" && s.value.series.length > 150)
    .map((s) => s.value);

  const maxLen = Math.max(0, ...pairs.map((p) => p.series.length));

  // --- F2 trend, live parameters --------------------------------------------
  const trendRuns = pairs.map((p) => {
    const { bt, extra } = backtestFxTrend(p.series, {
      ...LIVE_TREND,
      roundTripCostFraction: fxRoundTripFraction(p.symbol),
      differentialApr: carryApr(p.base, p.quote),
      swapMarkupApr: DEFAULT_SWAP_MARKUP_APR,
    });
    return { symbol: p.symbol, bt, extra };
  });

  // --- F2 sensitivity grid ---------------------------------------------------
  const sensitivity: SensitivityCell[] = [];
  for (const g of GRID) {
    for (const minStrengthPct of STRENGTHS) {
      const runs = pairs.map((p) =>
        backtestFxTrend(p.series, {
          fast: g.fast,
          slow: g.slow,
          minStrengthPct,
          roundTripCostFraction: fxRoundTripFraction(p.symbol),
          differentialApr: carryApr(p.base, p.quote),
          swapMarkupApr: DEFAULT_SWAP_MARKUP_APR,
        }),
      );
      const stats = portfolioOf(
        runs.map((r) => r.bt),
        runs.map((r) => r.bt),
      );
      sensitivity.push({
        fast: g.fast,
        slow: g.slow,
        minStrengthPct,
        totalReturnPct: stats.totalReturnPct,
        trades: runs.reduce((a, r) => a + r.bt.trades.length, 0),
      });
    }
  }

  // --- F1 carry --------------------------------------------------------------
  const carryRuns = pairs.map((p) => {
    const { bt, extra } = backtestFxCarry(p.series, {
      differentialApr: carryApr(p.base, p.quote),
      swapMarkupApr: DEFAULT_SWAP_MARKUP_APR,
      minNetApr: 0.01,
      roundTripCostFraction: fxRoundTripFraction(p.symbol),
      stopLossPct: STOP_LOSS_PCT,
    });
    return { symbol: p.symbol, bt, extra };
  });

  return {
    days: config.days,
    periodDays: Math.round((maxLen / FX_INTERVALS_PER_YEAR) * 365),
    trend: {
      portfolio: portfolioOf(
        trendRuns.map((r) => r.bt),
        trendRuns.map((r) => r.bt),
      ),
      priceReturn:
        trendRuns.reduce((a, r) => a + r.extra.priceReturn, 0) / Math.max(trendRuns.length, 1),
      carryReturn:
        trendRuns.reduce((a, r) => a + r.extra.carryReturn, 0) / Math.max(trendRuns.length, 1),
      pairs: trendRuns
        .map((r) => ({
          symbol: r.symbol,
          stats: carryStats(r.bt, FX_INTERVALS_PER_YEAR),
          extra: r.extra,
        }))
        .sort((a, b) => b.stats.totalReturnPct - a.stats.totalReturnPct),
      sensitivity,
      liveParams: LIVE_TREND,
    },
    carry: {
      portfolio: portfolioOf(
        carryRuns.map((r) => r.bt),
        carryRuns.map((r) => r.bt),
      ),
      priceReturn:
        carryRuns.reduce((a, r) => a + r.extra.priceReturn, 0) / Math.max(carryRuns.length, 1),
      carryReturn:
        carryRuns.reduce((a, r) => a + r.extra.carryReturn, 0) / Math.max(carryRuns.length, 1),
      pairs: carryRuns
        .map((r) => ({
          symbol: r.symbol,
          stats: carryStats(r.bt, FX_INTERVALS_PER_YEAR),
          extra: r.extra,
        }))
        .sort((a, b) => b.stats.totalReturnPct - a.stats.totalReturnPct),
    },
    caveats: [
      "Signals and stops are the live code (evaluateFxTrend, trendStopFraction) replayed on each day's prefix.",
      "Carry accrues at CURRENT policy-rate differentials minus the swap markup — historical rate paths are not modelled, so carry components over multi-year windows are an approximation.",
      "ECB daily fixes, not tradeable ticks; intraday moves and gaps between fixes are invisible.",
      "Costs are the live model: fx venue fees plus the per-pair modelled spread, charged in full at entry.",
      "Returns are on notional; the fx sleeves run 2–3x leverage which scales both directions.",
    ],
  };
}
