/**
 * Forex signal evaluation — the actual strategy behind the two FX sleeves.
 *
 * Until now the forex sleeves were mandates with no signal: definitions that
 * described a strategy without computing one. This module is the strategy. It
 * scores each major pair two ways, matching the two sleeves:
 *
 *   - **F1 · Carry** — hold the higher-yielding currency, earn the interest
 *     differential. The catch that sinks most retail carry is not the market,
 *     it is the broker: the swap markup on an overnight position is frequently
 *     large enough to make BOTH directions negative. So the differential is
 *     charged the markup here, and a pair is only "viable" when what survives is
 *     positive. A carry signal that ignores the swap cost is the single most
 *     common way this trade is mis-sold.
 *
 *   - **F2 · Trend** — a dual moving-average signal on daily closes, sized by
 *     realised volatility. Currencies trend on macro cycles that have nothing to
 *     do with crypto, which is the whole reason the forex book exists. Trend
 *     following in a range bleeds, so the signal reports its own strength and
 *     stays flat when the averages are entangled.
 *
 * Everything is a pure function of quotes and history so it can be tested with
 * hand-computable numbers — the same bar the crypto calc core is held to.
 */

import type { FxQuote } from "@/lib/market/forex";

/**
 * Typical retail broker swap markup, annualised, charged on top of the true
 * interest differential for holding a position overnight. Deliberately
 * conservative: this is the cost that decides whether a carry is real, so
 * understating it would manufacture edge that does not exist. ~1.5%/yr each way
 * is representative of a competitive-but-not-institutional broker.
 */
export const DEFAULT_SWAP_MARKUP_APR = 0.015;

export type FxDirection = "long" | "short" | "flat";

export type FxCarrySignal = {
  symbol: string;
  /** Which way to hold the pair to be paid the differential. */
  direction: FxDirection;
  /** base_rate − quote_rate, annualised. Sign is informational; direction uses it. */
  differentialApr: number;
  /** The differential in the profitable direction, always ≥ 0 before costs. */
  grossCarryApr: number;
  /** After the broker swap markup. This is what actually lands. */
  netCarryApr: number;
  /** True when the net carry clears a minimum worth the volatility risk. */
  viable: boolean;
  /** Why not, when not viable. */
  note: string;
};

/**
 * Score the carry on one pair.
 *
 * `minNetApr` is the floor the surviving carry must clear — picking up a 0.3%
 * net differential in front of a currency that can move 10% in a week is the
 * "nickels in front of a steamroller" trade, and the floor is what refuses it.
 */
export function evaluateFxCarry(
  quote: FxQuote,
  opts: { swapMarkupApr?: number; minNetApr?: number } = {},
): FxCarrySignal {
  const swap = opts.swapMarkupApr ?? DEFAULT_SWAP_MARKUP_APR;
  const minNetApr = opts.minNetApr ?? 0.01;

  const differentialApr = quote.carryApr;
  const grossCarryApr = Math.abs(differentialApr);
  // Long the base when the base out-yields the quote; short it otherwise. A
  // zero differential has no profitable side.
  const direction: FxDirection =
    differentialApr > 0 ? "long" : differentialApr < 0 ? "short" : "flat";

  const netCarryApr = grossCarryApr - swap;
  const viable = direction !== "flat" && netCarryApr >= minNetApr;

  const note =
    direction === "flat"
      ? "No rate differential to earn"
      : netCarryApr <= 0
        ? `Swap markup (${(swap * 100).toFixed(2)}%) eats the ${(grossCarryApr * 100).toFixed(2)}% differential`
        : !viable
          ? `Net carry ${(netCarryApr * 100).toFixed(2)}% below the ${(minNetApr * 100).toFixed(2)}% floor for the risk`
          : `Hold ${direction === "long" ? quote.base : quote.quote}, net ${(netCarryApr * 100).toFixed(2)}%/yr`;

  return {
    symbol: quote.symbol,
    direction,
    differentialApr,
    grossCarryApr,
    netCarryApr,
    viable,
    note,
  };
}

/** Simple moving average of the last `n` closes. Null when history is too short. */
export function sma(values: number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / n;
}

/**
 * Annualised volatility from daily closes.
 *
 * Standard deviation of daily log returns, scaled by √252 (FX trades business
 * days). This is the number that proves forex is the low-volatility book —
 * EUR/USD lands near 7%, against 30%+ for crypto.
 */
export function annualisedVol(closes: number[]): number | null {
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export type FxTrendSignal = {
  symbol: string;
  direction: FxDirection;
  fast: number | null;
  slow: number | null;
  /** Separation of the averages as a fraction of price — the conviction. */
  strengthPct: number;
  annualisedVol: number | null;
  /** True when the separation clears the noise floor and a side is taken. */
  engaged: boolean;
  note: string;
};

/**
 * Dual moving-average trend signal on daily closes.
 *
 * Fast above slow is an uptrend, and vice versa. The averages being within
 * `minStrengthPct` of each other is chop, not a trend — the signal stays flat
 * there rather than whipsawing on every crossover, which is where a naive
 * dual-MA system bleeds its capital.
 */
export function evaluateFxTrend(
  symbol: string,
  closes: number[],
  opts: { fast?: number; slow?: number; minStrengthPct?: number } = {},
): FxTrendSignal {
  const fastN = opts.fast ?? 20;
  const slowN = opts.slow ?? 60;
  const minStrengthPct = opts.minStrengthPct ?? 0.003; // 0.3% of price

  const fast = sma(closes, fastN);
  const slow = sma(closes, slowN);
  const vol = annualisedVol(closes);

  if (fast === null || slow === null || slow === 0) {
    return {
      symbol,
      direction: "flat",
      fast,
      slow,
      strengthPct: 0,
      annualisedVol: vol,
      engaged: false,
      note: `Need ${slowN} closes for the slow average`,
    };
  }

  const strengthPct = (fast - slow) / slow;
  const engaged = Math.abs(strengthPct) >= minStrengthPct;
  const direction: FxDirection = !engaged ? "flat" : strengthPct > 0 ? "long" : "short";

  return {
    symbol,
    direction,
    fast,
    slow,
    strengthPct,
    annualisedVol: vol,
    engaged,
    note: engaged
      ? `${direction === "long" ? "Up" : "Down"}trend, ${(Math.abs(strengthPct) * 100).toFixed(2)}% separation`
      : `Averages within ${(minStrengthPct * 100).toFixed(2)}% — ranging, staying flat`,
  };
}

/**
 * Volatility stop for a trend position, as a fraction of price.
 *
 * Two weekly standard deviations, derived from the pair's own annualised vol:
 * wide enough that ordinary noise does not shake the position out, tight
 * enough that a broken trend is cut before it becomes a drawdown. Clamped —
 * a suspiciously quiet pair still gets a real stop, and a wild one cannot
 * demand a stop so wide the position never dies.
 */
export function trendStopFraction(annualisedVol: number): number {
  const weeklySigma = annualisedVol * Math.sqrt(5 / 252);
  return Math.min(Math.max(2 * weeklySigma, 0.005), 0.06);
}

export type FxPairSignal = {
  symbol: string;
  rate: number;
  asOfDate: string;
  stale: boolean;
  carry: FxCarrySignal;
  trend: FxTrendSignal;
};

/** Score both strategies on one pair, given its quote and daily closes. */
export function scoreFxPair(
  quote: FxQuote,
  closes: number[],
  opts: {
    swapMarkupApr?: number;
    minNetApr?: number;
    fast?: number;
    slow?: number;
    minStrengthPct?: number;
  } = {},
): FxPairSignal {
  return {
    symbol: quote.symbol,
    rate: quote.rate,
    asOfDate: quote.asOfDate,
    stale: quote.stale,
    carry: evaluateFxCarry(quote, opts),
    trend: evaluateFxTrend(quote.symbol, closes, opts),
  };
}
