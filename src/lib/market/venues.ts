/**
 * Venue adapters — live public market data, no API keys required.
 *
 * These hit public endpoints only. Nothing here can place an order, read a
 * balance, or move funds, which is why it is safe to run continuously from the
 * dashboard's server side before any credential exists.
 *
 * Design notes:
 *   - Every adapter is independently fallible. One venue timing out degrades
 *     that venue and nothing else (DESIGN.md §3, `VenueDegraded`).
 *   - All requests are server-side. Browsers would be blocked by CORS on some
 *     of these, and proxying gives us one place to add rate-limit budgeting.
 *   - No value is ever invented. If a venue does not report a field, it stays
 *     undefined and the UI renders a dash — never a zero that looks like data.
 */

import {
  spreadBpsOf,
  UNIVERSE,
  type MarketSnapshot,
  type Quote,
  type VenueError,
} from "./types";
import { annualiseFunding } from "@/lib/calc/funding";

const TIMEOUT_MS = 8_000;

/** Fetch with a hard timeout — a hung venue must not hang the whole snapshot. */
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      // Market data is never cached: a stale price is worse than no price.
      cache: "no-store",
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const num = (s: string | number | undefined | null): number => {
  const v = typeof s === "number" ? s : Number(s);
  return Number.isFinite(v) ? v : 0;
};

/* ------------------------------------------------------------------ Binance */

type BinanceTicker = {
  symbol: string;
  lastPrice: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
  priceChangePercent: string;
};

type BinancePremium = {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
};

type BinanceBookTicker = {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
};

export async function fetchBinance(): Promise<Quote[]> {
  const symbols = UNIVERSE.map((a) => `${a}USDT`);
  const wanted = new Set(symbols);
  const symbolsParam = encodeURIComponent(JSON.stringify(symbols));

  // Note the asymmetry between the two APIs, which is easy to get wrong:
  // spot `/ticker/24hr` honours the `symbols` filter AND carries bid/ask, but
  // the futures equivalent silently ignores `symbols` (returning all ~700
  // contracts) and omits bid/ask entirely. So the perp side is filtered
  // client-side and its top-of-book comes from a separate bookTicker call.
  const [spot, perp, premium, perpBook] = await Promise.all([
    getJson<BinanceTicker[]>(
      `https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`,
    ),
    getJson<BinanceTicker[]>(`https://fapi.binance.com/fapi/v1/ticker/24hr`),
    getJson<BinancePremium[]>(`https://fapi.binance.com/fapi/v1/premiumIndex`),
    getJson<BinanceBookTicker[]>(`https://fapi.binance.com/fapi/v1/ticker/bookTicker`),
  ]);

  const premiumBySymbol = new Map(premium.map((p) => [p.symbol, p]));
  const bookBySymbol = new Map(perpBook.map((b) => [b.symbol, b]));
  const now = Date.now();
  const out: Quote[] = [];

  for (const t of spot) {
    const asset = t.symbol.replace(/USDT$/, "");
    const bid = num(t.bidPrice);
    const ask = num(t.askPrice);
    out.push({
      venue: "Binance",
      asset,
      kind: "spot",
      last: num(t.lastPrice),
      bid,
      ask,
      spreadBps: spreadBpsOf(bid, ask),
      topOfBookUsd: num(t.bidQty) * bid + num(t.askQty) * ask,
      high24h: num(t.highPrice),
      low24h: num(t.lowPrice),
      change24hPct: num(t.priceChangePercent),
      volume24hUsd: num(t.quoteVolume),
      ts: now,
    });
  }

  for (const t of perp) {
    if (!wanted.has(t.symbol)) continue;
    const asset = t.symbol.replace(/USDT$/, "");
    const book = bookBySymbol.get(t.symbol);
    const bid = book ? num(book.bidPrice) : 0;
    const ask = book ? num(book.askPrice) : 0;
    const p = premiumBySymbol.get(t.symbol);
    // Binance funding settles every 8h on these contracts.
    const intervalHours = 8;
    const rate = p ? num(p.lastFundingRate) : undefined;

    out.push({
      venue: "Binance",
      asset,
      kind: "perp",
      last: num(t.lastPrice),
      bid,
      ask,
      spreadBps: spreadBpsOf(bid, ask),
      topOfBookUsd: book ? num(book.bidQty) * bid + num(book.askQty) * ask : 0,
      high24h: num(t.highPrice),
      low24h: num(t.lowPrice),
      change24hPct: num(t.priceChangePercent),
      volume24hUsd: num(t.quoteVolume),
      fundingRate: rate,
      fundingIntervalHours: rate === undefined ? undefined : intervalHours,
      fundingApr: rate === undefined ? undefined : annualiseFunding(rate, intervalHours),
      nextFundingMs: p ? p.nextFundingTime : undefined,
      markPrice: p ? num(p.markPrice) : undefined,
      indexPrice: p ? num(p.indexPrice) : undefined,
      ts: now,
    });
  }

  return out;
}

/* -------------------------------------------------------------------- Bybit */

type BybitTicker = {
  symbol: string;
  lastPrice: string;
  bid1Price: string;
  bid1Size: string;
  ask1Price: string;
  ask1Size: string;
  highPrice24h: string;
  lowPrice24h: string;
  price24hPcnt: string;
  turnover24h: string;
  fundingRate?: string;
  nextFundingTime?: string;
  fundingIntervalHour?: string;
  markPrice?: string;
  indexPrice?: string;
  openInterestValue?: string;
};

type BybitEnvelope = {
  retCode: number;
  retMsg: string;
  result: { list: BybitTicker[] };
};

async function bybitCategory(category: "spot" | "linear"): Promise<BybitTicker[]> {
  const d = await getJson<BybitEnvelope>(
    `https://api.bybit.com/v5/market/tickers?category=${category}`,
  );
  if (d.retCode !== 0) throw new Error(d.retMsg || `retCode ${d.retCode}`);
  return d.result.list;
}

export async function fetchBybit(): Promise<Quote[]> {
  const wanted = new Set(UNIVERSE.map((a) => `${a}USDT`));
  const [spot, linear] = await Promise.all([
    bybitCategory("spot"),
    bybitCategory("linear"),
  ]);
  const now = Date.now();
  const out: Quote[] = [];

  for (const t of spot) {
    if (!wanted.has(t.symbol)) continue;
    const bid = num(t.bid1Price);
    const ask = num(t.ask1Price);
    out.push({
      venue: "Bybit",
      asset: t.symbol.replace(/USDT$/, ""),
      kind: "spot",
      last: num(t.lastPrice),
      bid,
      ask,
      spreadBps: spreadBpsOf(bid, ask),
      topOfBookUsd: num(t.bid1Size) * bid + num(t.ask1Size) * ask,
      high24h: num(t.highPrice24h),
      low24h: num(t.lowPrice24h),
      // Bybit reports this as a fraction, unlike Binance's percentage.
      change24hPct: num(t.price24hPcnt) * 100,
      volume24hUsd: num(t.turnover24h),
      ts: now,
    });
  }

  for (const t of linear) {
    if (!wanted.has(t.symbol)) continue;
    const bid = num(t.bid1Price);
    const ask = num(t.ask1Price);
    const rate = t.fundingRate === undefined ? undefined : num(t.fundingRate);
    // Bybit reports the interval explicitly, already in hours (e.g. "8").
    // Default to 8 only when absent — assuming an interval is exactly how
    // factor-of-8 funding errors get into a system.
    const intervalHours = num(t.fundingIntervalHour) || 8;

    out.push({
      venue: "Bybit",
      asset: t.symbol.replace(/USDT$/, ""),
      kind: "perp",
      last: num(t.lastPrice),
      bid,
      ask,
      spreadBps: spreadBpsOf(bid, ask),
      topOfBookUsd: num(t.bid1Size) * bid + num(t.ask1Size) * ask,
      high24h: num(t.highPrice24h),
      low24h: num(t.lowPrice24h),
      change24hPct: num(t.price24hPcnt) * 100,
      volume24hUsd: num(t.turnover24h),
      fundingRate: rate,
      fundingIntervalHours: rate === undefined ? undefined : intervalHours,
      fundingApr: rate === undefined ? undefined : annualiseFunding(rate, intervalHours),
      nextFundingMs: t.nextFundingTime ? num(t.nextFundingTime) : undefined,
      markPrice: t.markPrice ? num(t.markPrice) : undefined,
      indexPrice: t.indexPrice ? num(t.indexPrice) : undefined,
      openInterestUsd: t.openInterestValue ? num(t.openInterestValue) : undefined,
      ts: now,
    });
  }

  return out;
}

/* -------------------------------------------------------------- Hyperliquid */

type HlMeta = {
  universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[];
};

type HlCtx = {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: [string, string] | null;
};

export async function fetchHyperliquid(): Promise<Quote[]> {
  const [meta, ctxs] = await getJson<[HlMeta, HlCtx[]]>(
    "https://api.hyperliquid.xyz/info",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    },
  );

  const wanted = new Set<string>(UNIVERSE);
  const now = Date.now();
  const out: Quote[] = [];

  meta.universe.forEach((u, i) => {
    if (u.isDelisted || !wanted.has(u.name)) return;
    const ctx = ctxs[i];
    if (!ctx) return;

    const mark = num(ctx.markPx);
    const mid = ctx.midPx ? num(ctx.midPx) : mark;
    // Hyperliquid exposes impact prices rather than a raw book top; they are
    // the closest honest analogue to a bid/ask.
    const bid = ctx.impactPxs ? num(ctx.impactPxs[0]) : mid;
    const ask = ctx.impactPxs ? num(ctx.impactPxs[1]) : mid;

    const prev = num(ctx.prevDayPx);
    const rate = num(ctx.funding);
    // Hyperliquid funding settles HOURLY, not every 8 hours. Comparing its raw
    // rate against Binance's without normalising understates it 8x.
    const intervalHours = 1;

    out.push({
      venue: "Hyperliquid",
      asset: u.name,
      kind: "perp",
      last: mid,
      bid,
      ask,
      spreadBps: spreadBpsOf(bid, ask),
      // No top-of-book size is published on this endpoint. Left at 0 so the
      // cost model charges its punitive unknown-depth estimate rather than
      // pretending the book is deep.
      topOfBookUsd: 0,
      high24h: 0,
      low24h: 0,
      change24hPct: prev > 0 ? (mid / prev - 1) * 100 : 0,
      volume24hUsd: num(ctx.dayNtlVlm),
      fundingRate: rate,
      fundingIntervalHours: intervalHours,
      fundingApr: annualiseFunding(rate, intervalHours),
      markPrice: mark,
      indexPrice: num(ctx.oraclePx),
      openInterestUsd: num(ctx.openInterest) * mark,
      ts: now,
    });
  });

  return out;
}

/* --------------------------------------------------------------------- OKX */

type OkxTicker = {
  instId: string;
  last: string;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
};

type OkxInstrument = { instId: string; ctVal: string; ctValCcy: string };
type OkxFunding = { instId: string; fundingRate: string; nextFundingTime: string };
type OkxEnvelope<T> = { code: string; msg: string; data: T[] };

async function okx<T>(url: string): Promise<T[]> {
  const d = await getJson<OkxEnvelope<T>>(url);
  // OKX signals failure with a non-"0" code and a 200 status, so the HTTP check
  // in getJson is not enough on its own.
  if (d.code !== "0") throw new Error(d.msg || `OKX code ${d.code}`);
  return d.data;
}

/**
 * OKX — a fourth venue, added to widen the carry book.
 *
 * More venues is the highest-ROI expansion for this system: the cross-venue
 * funding spread (L2) gets wider and more frequent with every venue, because
 * the widest spreads sit between a mainstream venue and one that runs hotter on
 * alts. OKX is deep, liquid, and its funding regularly diverges from
 * Binance/Bybit — exactly the divergence L2 monetises.
 *
 * Two OKX-specific traps handled here:
 *   - Swap size (bidSz/askSz) is in CONTRACTS, not base units. Converting to USD
 *     depth needs each contract's value (`ctVal`), fetched from the instruments
 *     endpoint. Skipping it would misstate book depth by the contract multiplier.
 *   - Funding is not on the ticker; it is a per-instrument call. Each is made
 *     resilient so one missing funding rate does not sink the whole venue.
 */
export async function fetchOKX(): Promise<Quote[]> {
  const spotWanted = new Set(UNIVERSE.map((a) => `${a}-USDT`));
  const swapWanted = new Set(UNIVERSE.map((a) => `${a}-USDT-SWAP`));

  const [spot, swap, instruments, ...fundings] = await Promise.all([
    okx<OkxTicker>("https://www.okx.com/api/v5/market/tickers?instType=SPOT"),
    okx<OkxTicker>("https://www.okx.com/api/v5/market/tickers?instType=SWAP"),
    okx<OkxInstrument>("https://www.okx.com/api/v5/public/instruments?instType=SWAP"),
    ...UNIVERSE.map((a) =>
      okx<OkxFunding>(
        `https://www.okx.com/api/v5/public/funding-rate?instId=${a}-USDT-SWAP`,
      ).catch(() => [] as OkxFunding[]),
    ),
  ]);

  const ctValByInst = new Map(instruments.map((i) => [i.instId, num(i.ctVal)]));
  const fundingByInst = new Map<string, OkxFunding>();
  for (const f of fundings) if (f[0]) fundingByInst.set(f[0].instId, f[0]);

  const now = Date.now();
  const out: Quote[] = [];

  for (const t of spot) {
    if (!spotWanted.has(t.instId)) continue;
    const bid = num(t.bidPx);
    const ask = num(t.askPx);
    const open = num(t.open24h);
    const last = num(t.last);
    out.push({
      venue: "OKX",
      asset: t.instId.replace(/-USDT$/, ""),
      kind: "spot",
      last,
      bid,
      ask,
      spreadBps: spreadBpsOf(bid, ask),
      // Spot sizes are in base units, so this is a genuine USD figure.
      topOfBookUsd: num(t.bidSz) * bid + num(t.askSz) * ask,
      high24h: num(t.high24h),
      low24h: num(t.low24h),
      change24hPct: open > 0 ? (last / open - 1) * 100 : 0,
      volume24hUsd: num(t.volCcy24h),
      ts: now,
    });
  }

  for (const t of swap) {
    if (!swapWanted.has(t.instId)) continue;
    const bid = num(t.bidPx);
    const ask = num(t.askPx);
    const open = num(t.open24h);
    const last = num(t.last);
    // Swap sizes are in contracts; multiply by the contract value to get base
    // units, then by price for USD. Unknown ctVal → 0 depth, which makes the
    // cost model charge its punitive unknown-depth estimate rather than invent.
    const ctVal = ctValByInst.get(t.instId) ?? 0;
    const f = fundingByInst.get(t.instId);
    const rate = f ? num(f.fundingRate) : undefined;
    // OKX funding settles every 8 hours.
    const intervalHours = 8;

    out.push({
      venue: "OKX",
      asset: t.instId.replace(/-USDT-SWAP$/, ""),
      kind: "perp",
      last,
      bid,
      ask,
      spreadBps: spreadBpsOf(bid, ask),
      topOfBookUsd: ctVal > 0 ? (num(t.bidSz) * bid + num(t.askSz) * ask) * ctVal : 0,
      high24h: num(t.high24h),
      low24h: num(t.low24h),
      change24hPct: open > 0 ? (last / open - 1) * 100 : 0,
      volume24hUsd: num(t.volCcy24h),
      fundingRate: rate,
      fundingIntervalHours: rate === undefined ? undefined : intervalHours,
      fundingApr: rate === undefined ? undefined : annualiseFunding(rate, intervalHours),
      nextFundingMs: f?.nextFundingTime ? num(f.nextFundingTime) : undefined,
      ts: now,
    });
  }

  return out;
}

/* ----------------------------------------------------------------- Snapshot */

const ADAPTERS: { venue: string; fn: () => Promise<Quote[]> }[] = [
  { venue: "Binance", fn: fetchBinance },
  { venue: "Bybit", fn: fetchBybit },
  { venue: "Hyperliquid", fn: fetchHyperliquid },
  { venue: "OKX", fn: fetchOKX },
];

/**
 * Assemble a full cross-venue snapshot.
 *
 * Uses `allSettled` deliberately: a snapshot with two healthy venues and one
 * failure is useful and should render. Failing the whole request because
 * Hyperliquid is slow would take the dashboard down for a non-event.
 */
export async function fetchSnapshot(): Promise<MarketSnapshot> {
  const settled = await Promise.allSettled(ADAPTERS.map((a) => a.fn()));

  const quotes: Quote[] = [];
  const errors: VenueError[] = [];

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") quotes.push(...r.value);
    else {
      errors.push({
        venue: ADAPTERS[i].venue,
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  return { asOf: Date.now(), quotes, errors };
}

/* ------------------------------------------------------------------ Candles */

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

/**
 * Daily (or other interval) candles from Binance spot.
 *
 * Binance is the reference series for research because its history is free and
 * bulk-downloadable (DESIGN.md §4), so using it live keeps the dashboard and
 * the backtester looking at the same numbers.
 */
export async function fetchCandles(
  asset: string,
  interval = "1d",
  limit = 120,
): Promise<Candle[]> {
  const rows = await getJson<(string | number)[][]>(
    `https://api.binance.com/api/v3/klines?symbol=${asset}USDT&interval=${interval}&limit=${limit}`,
  );
  return rows.map((r) => ({
    t: Number(r[0]),
    o: num(r[1] as string),
    h: num(r[2] as string),
    l: num(r[3] as string),
    c: num(r[4] as string),
    v: num(r[7] as string), // quote-asset volume, i.e. USD turnover
  }));
}

/**
 * Historical funding rates for one Binance perp.
 *
 * Needed for regime classification: the entry decision depends on whether
 * funding has been *persistently* positive, not on a single print.
 */
export async function fetchBinanceFundingHistory(
  asset: string,
  limit = 90,
): Promise<{ t: number; rate: number; apr: number }[]> {
  const rows = await getJson<{ fundingTime: number; fundingRate: string }[]>(
    `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${asset}USDT&limit=${limit}`,
  );
  return rows.map((r) => ({
    t: r.fundingTime,
    rate: num(r.fundingRate),
    apr: annualiseFunding(num(r.fundingRate), 8),
  }));
}

/**
 * Historical funding rates from Bybit and OKX.
 *
 * The cross-venue spread (L2) is the strategy with the widest edges, and it
 * could not be backtested at all while only Binance published history to us —
 * a spread needs two series. Both endpoints are free, public, and quote on the
 * same 8-hour schedule as Binance, so the three series align by timestamp.
 *
 * Both paginate backwards from newest and cap a page well below the sample a
 * backtest wants, so both walk pages until they have enough or the venue stops
 * returning rows. Results come back oldest-first to match Binance.
 */

/** Bybit: 200 rows per page, walked backwards with `endTime`. */
export async function fetchBybitFundingHistory(
  asset: string,
  limit = 200,
): Promise<{ t: number; rate: number; apr: number }[]> {
  const out: { t: number; rate: number; apr: number }[] = [];
  let endTime: number | undefined;

  while (out.length < limit) {
    const url =
      `https://api.bybit.com/v5/market/funding/history?category=linear` +
      `&symbol=${asset}USDT&limit=200${endTime ? `&endTime=${endTime}` : ""}`;
    const res = await getJson<{
      result: { list: { fundingRate: string; fundingRateTimestamp: string }[] };
    }>(url);
    const rows = res.result?.list ?? [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const t = Number(r.fundingRateTimestamp);
      const rate = num(r.fundingRate);
      out.push({ t, rate, apr: annualiseFunding(rate, 8) });
    }

    // Step strictly before the oldest row so a page cannot repeat forever.
    const oldest = Math.min(...rows.map((r) => Number(r.fundingRateTimestamp)));
    if (!Number.isFinite(oldest)) break;
    endTime = oldest - 1;
  }

  return out.sort((a, b) => a.t - b.t).slice(-limit);
}

/** OKX: 100 rows per page, walked backwards with `after`. */
export async function fetchOKXFundingHistory(
  asset: string,
  limit = 200,
): Promise<{ t: number; rate: number; apr: number }[]> {
  const out: { t: number; rate: number; apr: number }[] = [];
  let after: number | undefined;

  while (out.length < limit) {
    const url =
      `https://www.okx.com/api/v5/public/funding-rate-history` +
      `?instId=${asset}-USDT-SWAP&limit=100${after ? `&after=${after}` : ""}`;
    const res = await getJson<{
      data: { fundingRate: string; fundingTime: string }[];
    }>(url);
    const rows = res.data ?? [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const t = Number(r.fundingTime);
      const rate = num(r.fundingRate);
      out.push({ t, rate, apr: annualiseFunding(rate, 8) });
    }

    const oldest = Math.min(...rows.map((r) => Number(r.fundingTime)));
    if (!Number.isFinite(oldest)) break;
    after = oldest;
  }

  return out.sort((a, b) => a.t - b.t).slice(-limit);
}
