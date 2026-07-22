/**
 * Stablecoin peg quotes (L3).
 *
 * One extra Binance book-ticker call per pass, normalised into the same
 * `Quote` shape everything else consumes — so prices, simulated books and
 * exits all see a stable like any other spot asset.
 *
 * The trade this feeds is deliberately one-sided: BUY a stable trading below
 * par and sell when the peg restores. The other side (shorting a stable above
 * par) needs borrow, which spot does not have, so it is not scored rather
 * than scored dishonestly. Deviations are rare and small in calm markets —
 * the scanner's value is that it is already watching when they are not
 * (USDC printed $0.88 in March 2023).
 */

import type { Quote } from "./types";

/** Stables watched against USDT on Binance. Deep books, zero-ish fees. */
export const STABLE_ASSETS = ["USDC", "FDUSD"] as const;

/** Par, in USDT. The peg being to the dollar and USDT ≈ $1 is an accepted
 * approximation here — the deviation that matters is the tradeable spread
 * between the two, which is exactly what this pair prices. */
export const STABLE_PAR = 1;

type BookTicker = {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
};

export async function fetchStableQuotes(): Promise<Quote[]> {
  const symbols = encodeURIComponent(
    JSON.stringify(STABLE_ASSETS.map((a) => `${a}USDT`)),
  );
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/bookTicker?symbols=${symbols}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Binance bookTicker HTTP ${res.status}`);
  const tickers = (await res.json()) as BookTicker[];

  const now = Date.now();
  const out: Quote[] = [];

  for (const t of tickers) {
    const asset = t.symbol.replace(/USDT$/, "");
    const bid = Number(t.bidPrice);
    const ask = Number(t.askPrice);
    if (!(bid > 0) || !(ask > 0)) continue;
    const mid = (bid + ask) / 2;

    out.push({
      venue: "Binance",
      asset,
      kind: "spot",
      last: mid,
      bid,
      ask,
      spreadBps: mid > 0 ? ((ask - bid) / mid) * 10_000 : 0,
      topOfBookUsd: Math.min(Number(t.bidQty) * bid, Number(t.askQty) * ask),
      high24h: 0,
      low24h: 0,
      change24hPct: 0,
      volume24hUsd: 0,
      ts: now,
    });
  }

  return out;
}

/** Deviation below par as a positive fraction; ≤ 0 means at or above par. */
export function pegDiscount(ask: number): number {
  return ask > 0 ? (STABLE_PAR - ask) / STABLE_PAR : 0;
}
