/**
 * Turning FX reference quotes into something the paper venue can fill against.
 *
 * The crypto feed arrives as a two-sided book with a real spread and depth. The
 * FX feed is a single daily reference fix — one number per pair. To paper-trade
 * it we have to synthesise the book, and the honest way to do that is to be
 * pessimistic about the spread, because the spread is the entire execution cost
 * in spot FX.
 *
 * Spreads are modelled per pair: the majors are a fraction of a pip, the rand is
 * an order of magnitude wider, and that difference is exactly why a ZAR carry
 * has to clear so much more before it is worth holding. These are typical retail
 * spreads, deliberately on the wide side — an edge that survives them survives
 * the real thing.
 */

import type { FxQuote } from "@/lib/market/forex";
import type { BookSnapshot } from "@/lib/oms/types";

/** The simulated FX venue id, matched by the fee table in `calc/costs.ts`. */
export const FX_VENUE = "fx";

/**
 * Typical retail round-trip spread per pair, in bps of price. Wider than an
 * institutional feed on purpose. The rand and other high-yielders are wide
 * precisely because that is where the carry is — the spread is the toll.
 */
const SPREAD_BPS: Record<string, number> = {
  EURUSD: 1.2,
  GBPUSD: 1.8,
  USDJPY: 1.5,
  AUDUSD: 2.0,
  USDCAD: 2.2,
  USDCHF: 2.2,
  USDZAR: 35,
};

const DEFAULT_SPREAD_BPS = 5;

export function fxSpreadBps(symbol: string): number {
  return SPREAD_BPS[symbol] ?? DEFAULT_SPREAD_BPS;
}

/**
 * A synthetic order book for one pair, centred on the reference rate with the
 * modelled spread around it. Depth is set generously — FX is the deepest market
 * there is, so at our sizes market impact is negligible and the spread is the
 * cost that matters.
 */
export function fxBookFromQuote(q: FxQuote): BookSnapshot {
  const spreadBps = fxSpreadBps(q.symbol);
  const half = (q.rate * spreadBps) / 2 / 10_000;
  return {
    asset: q.symbol,
    venue: FX_VENUE,
    market: "spot",
    bid: q.rate - half,
    ask: q.rate + half,
    spreadBps,
    // Deep enough that the square-root impact term is immaterial at our notional.
    topOfBookUsd: 5_000_000,
  };
}

export function fxBooks(quotes: FxQuote[]): BookSnapshot[] {
  return quotes.filter((q) => q.rate > 0).map(fxBookFromQuote);
}

/**
 * Mark prices for FX positions, keyed by pair symbol — the same key FX fills
 * use as their `asset`. Merged into the crypto price map so a single map marks
 * the whole book.
 */
export function fxPrices(quotes: FxQuote[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const q of quotes) if (q.rate > 0) m.set(q.symbol, q.rate);
  return m;
}
