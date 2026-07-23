/**
 * Running the H1 crypto-trend backtest on real Binance daily candles.
 *
 * H1 was originally validated by a one-off script; that made its evidence a
 * claim in a commit message rather than something the system can re-answer.
 * This runner closes that gap: same live parameters (Donchian entry/exit, ATR
 * trail from `engine/trendscan`), same cost model, pulled fresh from the same
 * candle endpoint the live scanner reads — so the automated re-validation pass
 * can grade H1 exactly like every other strategy.
 */

import { fetchCandles } from "@/lib/market/venues";
import { UNIVERSE } from "@/lib/market/types";
import { roundTripCost, type LegSpec } from "@/lib/calc/costs";
import { H1_ATR_K, H1_ENTRY_N, H1_EXIT_N } from "@/lib/engine/trendscan";
import { backtestCryptoTrend, type Ohlc } from "./cryptotrend";
import { carryStats, type CarryStats } from "./carry";

const DAYS_PER_YEAR = 365;

export type CryptoTrendBacktestConfig = {
  /** Daily candles to pull per asset (Binance serves up to 1000). */
  days: number;
};

export type CryptoTrendAssetResult = {
  asset: string;
  points: number;
  stats: CarryStats;
  buyHoldReturn: number;
  exits: { stop: number; band: number };
};

export type CryptoTrendBacktestResult = {
  params: { entryN: number; exitN: number; atrK: number };
  periodDays: number;
  costFraction: number;
  portfolio: { equity: { t: number; cumReturn: number }[]; stats: CarryStats };
  byAsset: CryptoTrendAssetResult[];
  caveats: string[];
};

/** Binance spot taker round trip, as a fraction of notional — the live model. */
function trendRoundTripFraction(notionalUsd = 1_000): number {
  const leg: LegSpec = {
    venue: "binance",
    market: "spot",
    liquidity: "taker",
    notionalUsd,
    spreadBps: 2,
    depthUsd: 5_000_000,
  };
  const cost = roundTripCost([leg]);
  return cost.totalUsd / notionalUsd;
}

/** Equal-weight the per-asset daily return streams, aligned at the tail. */
function combine(
  runs: { intervalReturns: number[]; equity: { t: number }[] }[],
): { equity: { t: number; cumReturn: number }[]; stats: CarryStats } {
  const maxLen = Math.max(0, ...runs.map((r) => r.intervalReturns.length));
  const refTimes =
    runs.find((r) => r.equity.length === maxLen)?.equity.map((e) => e.t) ?? [];

  const returns: number[] = [];
  const equity: { t: number; cumReturn: number }[] = [];
  let cum = 0;
  let held = 0;

  for (let i = 0; i < maxLen; i++) {
    let sum = 0;
    let n = 0;
    for (const r of runs) {
      const off = r.intervalReturns.length - maxLen + i;
      if (off >= 0) {
        sum += r.intervalReturns[off];
        n += 1;
        if (r.intervalReturns[off] !== 0) held += 1 / Math.max(runs.length, 1);
      }
    }
    const v = n > 0 ? sum / n : 0;
    returns.push(v);
    cum += v;
    equity.push({ t: refTimes[i] ?? i, cumReturn: cum });
  }

  const stats = carryStats(
    {
      trades: [],
      equity,
      intervalReturns: returns,
      intervalsHeld: held,
      intervalsTotal: maxLen,
    },
    DAYS_PER_YEAR,
  );
  return { equity, stats };
}

export async function runCryptoTrendBacktest(
  config: CryptoTrendBacktestConfig,
): Promise<CryptoTrendBacktestResult> {
  const costFraction = trendRoundTripFraction();
  const params = { entryN: H1_ENTRY_N, exitN: H1_EXIT_N, atrK: H1_ATR_K };

  const settled = await Promise.allSettled(
    UNIVERSE.map(async (asset) => ({
      asset,
      series: (await fetchCandles(asset, "1d", config.days)) as Ohlc[],
    })),
  );

  const byAsset: CryptoTrendAssetResult[] = [];
  const runs: { bt: ReturnType<typeof backtestCryptoTrend>["bt"] }[] = [];
  const tradesAll: ReturnType<typeof backtestCryptoTrend>["bt"]["trades"] = [];

  for (const s of settled) {
    // Too short to form the entry band at all: skip rather than report noise.
    if (s.status !== "fulfilled" || s.value.series.length < H1_ENTRY_N + 30) continue;
    const { bt, extra } = backtestCryptoTrend(s.value.series, {
      ...params,
      roundTripCostFraction: costFraction,
    });
    runs.push({ bt });
    tradesAll.push(...bt.trades);
    byAsset.push({
      asset: s.value.asset,
      points: s.value.series.length,
      stats: carryStats(bt, DAYS_PER_YEAR),
      buyHoldReturn: extra.buyHoldReturn,
      exits: extra.exits,
    });
  }

  if (runs.length === 0) throw new Error("No candle history available");

  const portfolio = combine(runs.map((r) => r.bt));
  // The combiner has no trade list of its own; the portfolio's trade record is
  // the union of the per-asset trades, so win rate and counts stay honest.
  const wins = tradesAll.filter((t) => t.win).length;
  portfolio.stats.trades = tradesAll.length;
  portfolio.stats.wins = wins;
  portfolio.stats.winRate = tradesAll.length > 0 ? wins / tradesAll.length : 0;
  portfolio.stats.avgHoldIntervals =
    tradesAll.length > 0
      ? tradesAll.reduce((a, t) => a + t.intervals, 0) / tradesAll.length
      : 0;

  const periodDays = Math.max(0, ...byAsset.map((a) => a.points));

  return {
    params,
    periodDays,
    costFraction,
    portfolio,
    byAsset,
    caveats: [
      "Long-only spot at the live H1 parameters — no leverage, no shorts, matching what the Systematic sleeve actually trades.",
      "Costs are the live Binance spot taker model charged in full at entry; slippage beyond the modelled spread is not simulated.",
      "Equal-weight portfolio across assets; the live book concentrates by signal strength, so live results will differ in size but not in sign.",
      "Trend returns are lumpy by nature — a few large winners pay for many small stops. Judge the whole curve, not a month.",
    ],
  };
}
