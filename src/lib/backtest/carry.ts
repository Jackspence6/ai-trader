/**
 * Funding-carry backtest.
 *
 * The system trades once a day on the deployment's cron, so a live track record
 * takes months to mean anything. This answers the same question now, from real
 * history: **over the last few months, would harvesting funding carry have made
 * money after costs?**
 *
 * DESIGN.md §9 is blunt: a backtester that lies is worse than none, because it
 * manufactures confidence. So this one is deliberately honest about its scope
 * and pessimistic in its assumptions:
 *
 *   - It models the **single-venue funding carry (L1)** only — long spot, short
 *     perp, same asset. That position is delta-neutral, so its P&L is the
 *     funding it collects minus the cost to get in and out; the price path
 *     cancels between the legs. This is why the simulation runs on the real
 *     funding-rate series and does not need to guess a price path.
 *   - Entry uses the SAME rules as the live scanner: a funding-APR floor and a
 *     persistence filter (funding positive across most of a trailing window, so
 *     a single liquidation-spike print cannot trigger an entry).
 *   - Exit uses the SAME rule as the live exit manager: close once funding is no
 *     longer positive.
 *   - The round-trip cost is charged up front, in full, so a trade must earn its
 *     costs back before it shows a profit.
 *
 * What it does NOT claim: it is not L2 or FX (those need multi-venue / FX
 * history), it ignores the basis drift between the spot and perp legs, and it
 * assumes the modelled cost is paid. Returns are on **notional** — leverage
 * would amplify return on capital by the usual L/(L+1), and that is left to the
 * reader rather than baked in to flatter the number.
 */

export type FundingPoint = {
  t: number;
  /** Funding rate for one interval, as a fraction (what a short receives). */
  rate: number;
  /** Annualised funding, for the entry/exit thresholds. */
  apr: number;
};

export type CarryBacktestParams = {
  /** Minimum annualised funding to open, matching the live floor. */
  minFundingApr: number;
  /** Minimum share of the trailing window that must be positive to open. */
  minPositiveShare: number;
  /** Trailing window length for the persistence filter, in intervals. */
  regimeWindow: number;
  /** Total round-trip cost (both legs, both directions) as a fraction of notional. */
  roundTripCostFraction: number;
  /**
   * Expected hold in days, used to amortise the entry cost — the live scanner's
   * `expectedHoldDays`. The gate assumes the funding will persist this long;
   * whether it actually does is exactly what the backtest reveals.
   */
  expectedHoldDays: number;
  /** Minimum net edge (bps) over the expected hold, matching the live gate. */
  minNetEdgeBps: number;
};

export type BacktestTrade = {
  entryT: number;
  exitT: number;
  intervals: number;
  /** Funding collected while held, as a fraction of notional. */
  fundingReturn: number;
  /** Funding minus the round-trip cost. */
  netReturn: number;
  win: boolean;
};

export type CarryBacktest = {
  trades: BacktestTrade[];
  /** Cumulative net return on notional, one point per input interval. */
  equity: { t: number; cumReturn: number }[];
  /** Per-interval net returns, for volatility / Sharpe. */
  intervalReturns: number[];
  intervalsHeld: number;
  intervalsTotal: number;
};

/** Share of the trailing `window` intervals (ending at `i`, inclusive) that were positive. */
function positiveShare(series: FundingPoint[], i: number, window: number): number {
  const start = Math.max(0, i - window + 1);
  let positive = 0;
  let n = 0;
  for (let j = start; j <= i; j++) {
    n += 1;
    if (series[j].rate > 0) positive += 1;
  }
  return n > 0 ? positive / n : 0;
}

/**
 * Simulate the carry on one asset's funding series.
 *
 * The state machine is intentionally the same shape as the live system: flat
 * until the edge is rich and persistent, then hold and collect until funding
 * inverts.
 */
export function backtestCarry(
  series: FundingPoint[],
  params: CarryBacktestParams,
): CarryBacktest {
  const trades: BacktestTrade[] = [];
  const equity: { t: number; cumReturn: number }[] = [];
  const intervalReturns: number[] = [];

  let cum = 0;
  let inPosition = false;
  let entryT = 0;
  let entryIndex = 0;
  let fundingAcc = 0;
  let intervalsHeld = 0;

  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    let intervalReturn = 0;

    if (!inPosition) {
      // Enter when funding is rich, persistent, AND the net edge over the
      // ASSUMED hold clears the live gate — the same three checks the scanner
      // runs. The gate trusts `expectedHoldDays`; the simulation then holds only
      // as long as funding actually stays positive, which is where the gap
      // between assumed and realised profitability shows up.
      const persistent = positiveShare(series, i, params.regimeWindow) >= params.minPositiveShare;
      const netEdgeBps =
        (p.apr * (params.expectedHoldDays / 365) - params.roundTripCostFraction) * 10_000;
      if (p.apr >= params.minFundingApr && persistent && netEdgeBps >= params.minNetEdgeBps) {
        inPosition = true;
        entryT = p.t;
        entryIndex = i;
        fundingAcc = 0;
        // Charge the whole round trip up front: the trade owes its costs before
        // it is allowed to look profitable.
        intervalReturn -= params.roundTripCostFraction;
      }
    } else {
      // Collect this interval's funding.
      intervalReturn += p.rate;
      fundingAcc += p.rate;
      intervalsHeld += 1;

      // Exit once funding is no longer positive — the thesis is gone.
      if (p.apr < 0) {
        trades.push({
          entryT,
          exitT: p.t,
          intervals: i - entryIndex,
          fundingReturn: fundingAcc,
          netReturn: fundingAcc - params.roundTripCostFraction,
          win: fundingAcc - params.roundTripCostFraction > 0,
        });
        inPosition = false;
      }
    }

    cum += intervalReturn;
    intervalReturns.push(intervalReturn);
    equity.push({ t: p.t, cumReturn: cum });
  }

  // A position still open at the end of the series is marked to its funding so
  // far, but not counted as a completed trade.
  return {
    trades,
    equity,
    intervalReturns,
    intervalsHeld,
    intervalsTotal: series.length,
  };
}

export type CarryStats = {
  totalReturnPct: number;
  annualisedReturnPct: number;
  trades: number;
  wins: number;
  winRate: number;
  avgHoldIntervals: number;
  maxDrawdownPct: number;
  /** Annualised Sharpe of the per-interval return stream. */
  sharpe: number | null;
  /** Fraction of the period actually in a position. */
  timeInMarket: number;
};

/** Intervals per year for 8-hour funding (Binance/Bybit/OKX). */
export const INTERVALS_PER_YEAR_8H = (24 * 365) / 8;

/**
 * Summary statistics for a backtest.
 *
 * `intervalsPerYear` annualises both return and Sharpe; default is the 8-hour
 * funding cadence. Max drawdown is on the cumulative-return equity curve.
 */
export function carryStats(
  bt: CarryBacktest,
  intervalsPerYear = INTERVALS_PER_YEAR_8H,
): CarryStats {
  const total = bt.equity.length > 0 ? bt.equity[bt.equity.length - 1].cumReturn : 0;
  const periods = bt.intervalsTotal;
  const years = periods > 0 ? periods / intervalsPerYear : 0;

  // Max drawdown on the equity curve (returns are additive fractions here).
  let peak = 0;
  let maxDd = 0;
  for (const e of bt.equity) {
    if (e.cumReturn > peak) peak = e.cumReturn;
    const dd = peak - e.cumReturn;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe from the per-interval returns, annualised.
  const rs = bt.intervalReturns;
  let sharpe: number | null = null;
  if (rs.length >= 2) {
    const mean = rs.reduce((a, r) => a + r, 0) / rs.length;
    const variance = rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (rs.length - 1);
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(intervalsPerYear) : null;
  }

  const wins = bt.trades.filter((t) => t.win).length;

  return {
    totalReturnPct: total,
    annualisedReturnPct: years > 0 ? total / years : 0,
    trades: bt.trades.length,
    wins,
    winRate: bt.trades.length > 0 ? wins / bt.trades.length : 0,
    avgHoldIntervals:
      bt.trades.length > 0
        ? bt.trades.reduce((a, t) => a + t.intervals, 0) / bt.trades.length
        : 0,
    maxDrawdownPct: maxDd,
    sharpe,
    timeInMarket: periods > 0 ? bt.intervalsHeld / periods : 0,
  };
}
