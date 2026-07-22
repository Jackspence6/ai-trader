/**
 * Dated-futures basis data — spot vs quarterly future, for cash-and-carry.
 *
 * Binance lists USDⓈ-M quarterly delivery futures alongside the perpetuals;
 * their symbols carry the settlement date (`BTCUSDT_250926`). Only the deepest
 * assets have them — today that is BTC and ETH — which is exactly where we want
 * to run a basis trade anyway. We read the future prices from the same futures
 * ticker the perp feed already uses, and pair each with its spot price.
 *
 * Everything here is public market data. Nothing places an order.
 */

import { evaluateBasis, parseDeliveryExpiry, type BasisResult } from "@/lib/calc/basis";
import { roundTripCost, type LegSpec } from "@/lib/calc/costs";

const TIMEOUT_MS = 8_000;
const BASIS_ASSETS = ["BTC", "ETH"] as const;

async function getJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type Ticker = { symbol: string; lastPrice: string; bidPrice?: string; askPrice?: string };

export type BasisQuote = {
  asset: string;
  /** The dated-future symbol, e.g. "BTCUSDT_250926". */
  futureSymbol: string;
  expiryMs: number;
  spot: number;
  future: number;
};

/**
 * Fetch the nearest quarterly future and its spot for every basis asset.
 *
 * Picks the *nearest* expiry per asset — the closest future is the most liquid
 * and the one whose basis is least polluted by far-dated uncertainty.
 */
export async function fetchBasisQuotes(now: number = Date.now()): Promise<BasisQuote[]> {
  const [futures, spots] = await Promise.all([
    getJson<Ticker[]>("https://fapi.binance.com/fapi/v1/ticker/24hr"),
    getJson<Ticker[]>("https://api.binance.com/api/v3/ticker/price"),
  ]);

  const spotByAsset = new Map<string, number>();
  for (const s of spots) {
    const m = s.symbol.match(/^([A-Z]+)USDT$/);
    if (m && BASIS_ASSETS.includes(m[1] as (typeof BASIS_ASSETS)[number])) {
      spotByAsset.set(m[1], Number(s.lastPrice ?? (s as { price?: string }).price));
    }
  }

  const nearest = new Map<string, BasisQuote>();
  for (const f of futures) {
    const m = f.symbol.match(/^([A-Z]+)USDT_(\d{6})$/);
    if (!m) continue;
    const asset = m[1];
    if (!BASIS_ASSETS.includes(asset as (typeof BASIS_ASSETS)[number])) continue;

    const expiryMs = parseDeliveryExpiry(f.symbol);
    const spot = spotByAsset.get(asset);
    if (expiryMs === null || expiryMs <= now || !spot) continue;

    const q: BasisQuote = {
      asset,
      futureSymbol: f.symbol,
      expiryMs,
      spot,
      future: Number(f.lastPrice),
    };
    const existing = nearest.get(asset);
    if (!existing || q.expiryMs < existing.expiryMs) nearest.set(asset, q);
  }

  return [...nearest.values()];
}

export type BasisSignal = BasisQuote & { result: BasisResult };

/**
 * Score every basis quote, at a given notional.
 *
 * Both legs trade on Binance — spot and the dated future — so the round-trip
 * cost is the two legs crossing the spread and paying fees, from the same cost
 * model the funding scanner uses. Depth is set generously; BTC/ETH books are
 * deep and the basis, not impact, is what the trade lives or dies on.
 */
export function scoreBasis(
  quotes: BasisQuote[],
  legNotionalUsd: number,
  now: number = Date.now(),
): BasisSignal[] {
  return quotes
    .map((q) => {
      const leg = (market: "spot" | "perp"): LegSpec => ({
        venue: "binance",
        market,
        liquidity: "taker",
        notionalUsd: legNotionalUsd,
        spreadBps: 2,
        depthUsd: 2_000_000,
      });
      const cost = roundTripCost([leg("spot"), leg("perp")]);
      return {
        ...q,
        result: evaluateBasis({
          spot: q.spot,
          future: q.future,
          expiryMs: q.expiryMs,
          now,
          cost,
          legNotionalUsd,
        }),
      };
    })
    .sort((a, b) => b.result.netEdgeBps - a.result.netEdgeBps);
}
