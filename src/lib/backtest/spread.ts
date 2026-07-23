/**
 * Cross-venue funding-spread backtest (L2).
 *
 * L2 is the strategy carrying the widest live edges — 30–50bp net where L1
 * carry scores 25–30 — and until now it had **no** backtest at all, because a
 * spread needs two funding series and only Binance published history to us.
 * With Bybit and OKX history added, this answers the question the L1 backtest
 * already answers for carry: *does the edge survive costs on real history?*
 *
 * The trade: short the perp on the venue paying richer funding, long the perp
 * on the cheaper one, same asset and size. Both legs are perps, so price
 * largely cancels and the P&L is the funding differential minus costs. A short
 * receives funding when it is positive and a long pays it, so each interval
 * earns `rateShort − rateLong` on one leg's notional.
 *
 * Direction is chosen at entry from the sign of the spread and then held —
 * exactly what the live scanner does when it sorts venues by funding and picks
 * the richest to short against the cheapest to long. The spread can and does
 * cross zero while held; whether to exit on that is precisely the parameter
 * this module exists to measure.
 *
 * Honest about scope, in the spirit of DESIGN.md §9:
 *   - It assumes both legs fill at the modelled cost, charged in full up front.
 *   - It ignores basis drift between the two venues' marks — real but second
 *     order next to the funding differential over a multi-day hold.
 *   - It ignores the margin cost of holding two perp positions rather than one.
 *   - Returns are on ONE leg's notional; leverage is left to the reader.
 */

import { carryStats, type CarryBacktest, type CarryStats } from "./carry";

export type SpreadPoint = {
  t: number;
  /** Per-interval funding on the venue we may short. */
  rateA: number;
  /** Per-interval funding on the venue we may long. */
  rateB: number;
  /** Annualised A − B. Positive means A is the rich side. */
  spreadApr: number;
};

export type SpreadBacktestParams = {
  /** Minimum absolute annualised spread to open. */
  minSpreadApr: number;
  /** Minimum net edge (bps) over the expected hold, matching the live gate. */
  minNetEdgeBps: number;
  /** Round-trip cost across both perp legs, as a fraction of one leg. */
  roundTripCostFraction: number;
  expectedHoldDays: number;
  /**
   * Exit once the held spread falls below this annualised level. Zero is the
   * naive rule; a negative value is the deadband that lets a spread graze
   * zero without buying a round trip. THIS IS THE PARAMETER UNDER TEST.
   */
  exitSpreadApr: number;
  /** Trailing window for median confirmation, in intervals. 0 disables it. */
  regimeWindow?: number;
};

/** Align two venue series onto shared funding intervals. */
export function alignSeries(
  a: { t: number; rate: number; apr: number }[],
  b: { t: number; rate: number; apr: number }[],
  intervalHours = 8,
): SpreadPoint[] {
  // Binance stamps funding times with millisecond jitter (…16:00:00.002)
  // while Bybit and OKX are exact. Joining on the raw timestamp silently
  // drops half the rows, so both sides bucket to the interval boundary first.
  const bucket = intervalHours * 3600_000;
  const key = (t: number) => Math.round(t / bucket) * bucket;

  const byBucket = new Map<number, number>();
  for (const r of b) byBucket.set(key(r.t), r.rate);

  const out: SpreadPoint[] = [];
  for (const r of a) {
    const k = key(r.t);
    const rateB = byBucket.get(k);
    if (rateB === undefined) continue;
    const intervalsPerYear = (24 * 365) / intervalHours;
    out.push({
      t: k,
      rateA: r.rate,
      rateB,
      spreadApr: (r.rate - rateB) * intervalsPerYear,
    });
  }
  return out.sort((x, y) => x.t - y.t);
}

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Simulate the spread on one asset's aligned series.
 *
 * State machine mirrors the live system: flat until the spread is rich enough
 * to clear the gate, then hold — earning the differential in the direction
 * entered — until the exit rule fires.
 */
export function backtestSpread(
  series: SpreadPoint[],
  params: SpreadBacktestParams,
): CarryBacktest {
  const trades: CarryBacktest["trades"] = [];
  const equity: { t: number; cumReturn: number }[] = [];
  const intervalReturns: number[] = [];

  let cum = 0;
  let inPosition = false;
  /** +1 = short A / long B. −1 = short B / long A. */
  let dir = 0;
  let entryT = 0;
  let entryIndex = 0;
  let acc = 0;
  let intervalsHeld = 0;

  const window = params.regimeWindow ?? 0;

  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    let intervalReturn = 0;

    if (!inPosition) {
      // Enter on either side: a deeply negative spread is just as tradeable
      // with the legs reversed, which is what the live scanner does when it
      // sorts venues by funding.
      const side = p.spreadApr >= 0 ? 1 : -1;
      const absApr = Math.abs(p.spreadApr);
      const netEdgeBps =
        (absApr * (params.expectedHoldDays / 365) - params.roundTripCostFraction) * 10_000;

      if (absApr >= params.minSpreadApr && netEdgeBps >= params.minNetEdgeBps) {
        inPosition = true;
        dir = side;
        entryT = p.t;
        entryIndex = i;
        acc = 0;
        // The whole round trip is charged up front: the trade owes its costs
        // before it is allowed to look profitable.
        intervalReturn -= params.roundTripCostFraction;
      }
    } else {
      const earned = dir * (p.rateA - p.rateB);
      intervalReturn += earned;
      acc += earned;
      intervalsHeld += 1;

      const heldApr = dir * p.spreadApr;
      let shouldExit = heldApr < params.exitSpreadApr;

      // Median confirmation, where a window is configured: a single print
      // through the deadband is noise if the regime still favours the trade.
      if (shouldExit && window > 0) {
        const from = Math.max(0, i - window + 1);
        const med = median(series.slice(from, i + 1).map((s) => dir * s.spreadApr));
        if (med >= 0) shouldExit = false;
      }

      if (shouldExit) {
        trades.push({
          entryT,
          exitT: p.t,
          intervals: i - entryIndex,
          fundingReturn: acc,
          netReturn: acc - params.roundTripCostFraction,
          win: acc - params.roundTripCostFraction > 0,
        });
        inPosition = false;
      }
    }

    cum += intervalReturn;
    intervalReturns.push(intervalReturn);
    equity.push({ t: p.t, cumReturn: cum });
  }

  return {
    trades,
    equity,
    intervalReturns,
    intervalsHeld,
    intervalsTotal: series.length,
  };
}

export type SweepPoint = {
  /** The exit deadband tested, annualised. */
  exitSpreadApr: number;
  stats: CarryStats;
  /** Round trips taken — the churn number the deadband exists to reduce. */
  trades: number;
};

/**
 * Sweep the exit deadband across a set of candidate values.
 *
 * The point of a sweep rather than a single number: a parameter that only
 * works at one exact value is overfit (DESIGN.md §8.8), and the shape of the
 * curve says more than its peak. A deadband that improves returns smoothly
 * across a range is a real effect; a spike at one value is noise.
 */
export function sweepExitDeadband(
  seriesByAsset: SpreadPoint[][],
  params: Omit<SpreadBacktestParams, "exitSpreadApr">,
  candidates: number[],
): SweepPoint[] {
  return candidates.map((exitSpreadApr) => {
    const runs = seriesByAsset.map((s) =>
      backtestSpread(s, { ...params, exitSpreadApr }),
    );

    // Equal-weight the assets: average per-interval returns across whichever
    // assets cover each interval, aligned from the most recent point back.
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

    const composite: CarryBacktest = {
      trades: runs.flatMap((r) => r.trades),
      equity,
      intervalReturns: returns,
      intervalsHeld:
        runs.length > 0
          ? (runs.reduce((s, r) => s + r.intervalsHeld / Math.max(r.intervalsTotal, 1), 0) /
              runs.length) *
            maxLen
          : 0,
      intervalsTotal: maxLen,
    };

    return {
      exitSpreadApr,
      stats: carryStats(composite),
      trades: composite.trades.length,
    };
  });
}
