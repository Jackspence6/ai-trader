/**
 * Normalised market types.
 *
 * Every venue speaks a different dialect — Binance quotes funding per 8h,
 * Hyperliquid per hour; Bybit reports open interest in base units on one
 * endpoint and USD on another. Normalising at the edge means the calculation
 * core never has to know which exchange a number came from, which is what makes
 * cross-venue comparison trustworthy rather than a source of factor-of-eight
 * bugs.
 */

export type MarketKind = "spot" | "perp";

export type Quote = {
  venue: string;
  /** Base asset, e.g. "BTC". Venue-specific symbols are normalised away. */
  asset: string;
  kind: MarketKind;
  last: number;
  bid: number;
  ask: number;
  /** Quoted spread in basis points, relative to mid. */
  spreadBps: number;
  /** Visible size at the touch, in USD. Honest about being top-of-book only. */
  topOfBookUsd: number;
  high24h: number;
  low24h: number;
  change24hPct: number;
  /** 24h turnover in USD. */
  volume24hUsd: number;

  /* ---- perp only ---- */
  /** Funding rate for ONE interval, as a fraction. */
  fundingRate?: number;
  /** Length of that interval in hours — 8 on Binance/Bybit, 1 on Hyperliquid. */
  fundingIntervalHours?: number;
  /** Annualised funding, precomputed so the UI never re-derives it wrongly. */
  fundingApr?: number;
  nextFundingMs?: number;
  markPrice?: number;
  indexPrice?: number;
  openInterestUsd?: number;

  /** When the venue produced this data. */
  ts: number;
};

export type VenueError = {
  venue: string;
  message: string;
};

export type MarketSnapshot = {
  /** When we assembled the snapshot (ms epoch). */
  asOf: number;
  quotes: Quote[];
  /** Venues that failed. A degraded venue is data, not an exception. */
  errors: VenueError[];
};

/**
 * The trading universe for phase 1.
 *
 * Deliberately short. DESIGN.md §7 T1/T2 permit only 1–2 majors, and a scanner
 * watching 200 symbols at $1k NAV is generating opportunities it can never
 * fund. These are the assets with deep books and reliable funding on all three
 * venues.
 */
export const UNIVERSE = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "AVAX", "LINK"] as const;

export type Asset = (typeof UNIVERSE)[number];

export function isUniverseAsset(s: string): s is Asset {
  return (UNIVERSE as readonly string[]).includes(s);
}

/** Spread in bps from a bid/ask pair, guarding against crossed or empty books. */
export function spreadBpsOf(bid: number, ask: number): number {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return 0;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 10_000;
}
