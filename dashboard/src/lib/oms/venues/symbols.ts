/**
 * Venue trading rules — tick size, lot size, minimum notional.
 *
 * This is the file that separates "my simulator accepted it" from "the exchange
 * accepted it". A simulator will happily fill 0.123456789 BTC at 64123.4567; a
 * real venue rejects both the quantity and the price for violating step and
 * tick size, and returns an error that says nothing useful about which.
 *
 * Every rule here is fetched from the venue itself rather than hardcoded.
 * Hardcoding them means the day an exchange changes a tick size, every order on
 * that symbol starts failing for a reason nobody can find.
 *
 * Rounding is always DOWN for quantity and always toward the passive side for
 * price. Rounding up a quantity can breach a position limit that was computed
 * before rounding — a small breach, but a breach the risk gate already approved
 * against, which makes it invisible.
 */

export type SymbolRules = {
  symbol: string;
  venue: string;
  market: "spot" | "perp";
  status: string;
  tradable: boolean;
  tickSize: number;
  stepSize: number;
  minQty: number;
  maxQty: number;
  minNotionalUsd: number;
  /** Decimal places implied by tickSize/stepSize, for formatting. */
  pricePrecision: number;
  qtyPrecision: number;
  fetchedAt: number;
};

/** Decimal places implied by a step like "0.00001000" → 5. */
export function precisionOf(step: number): number {
  if (!(step > 0)) return 0;
  const s = step.toExponential();
  const [mantissa, exp] = s.split("e");
  const e = Number(exp);
  if (e >= 0) return 0;
  const mantissaDecimals = (mantissa.split(".")[1] ?? "").length;
  return Math.max(0, -e + mantissaDecimals);
}

/**
 * Round a quantity DOWN to the venue's step size.
 *
 * Down, always. Rounding up can push a size past a limit the risk gate already
 * approved it against, and a breach that happens after approval is a breach
 * nobody sees.
 *
 * The multiply-round-divide dance avoids floating point leaving artefacts like
 * 0.30000000000000004, which venues reject.
 */
export function quantiseQty(qty: number, rules: SymbolRules): number {
  if (!(rules.stepSize > 0)) return qty;
  const p = rules.qtyPrecision;
  const steps = Math.floor(qty / rules.stepSize + 1e-9);
  return Number((steps * rules.stepSize).toFixed(p));
}

/**
 * Round a price to the venue's tick size, toward the passive side.
 *
 * A buy rounds DOWN and a sell rounds UP, so quantisation never makes an order
 * more aggressive than intended. The opposite convention would let rounding
 * cross the spread on its own.
 */
export function quantisePrice(
  price: number,
  side: "buy" | "sell",
  rules: SymbolRules,
): number {
  if (!(rules.tickSize > 0)) return price;
  const p = rules.pricePrecision;
  const ticks =
    side === "buy"
      ? Math.floor(price / rules.tickSize + 1e-9)
      : Math.ceil(price / rules.tickSize - 1e-9);
  return Number((ticks * rules.tickSize).toFixed(p));
}

export type OrderValidation =
  | { ok: true; qty: number; notionalUsd: number }
  | { ok: false; reason: string };

/**
 * Quantise and validate an order against the venue's rules, before sending it.
 *
 * Catching a violation here rather than at the venue matters for more than
 * politeness: a rejected order still consumed a rate-limit slot, still took a
 * network round trip, and returns an error too generic to act on.
 */
export function validateOrder(
  rawQty: number,
  price: number,
  rules: SymbolRules,
): OrderValidation {
  if (!rules.tradable) {
    return { ok: false, reason: `${rules.symbol} is not tradable (status ${rules.status})` };
  }

  const qty = quantiseQty(rawQty, rules);

  if (qty <= 0) {
    return {
      ok: false,
      reason: `Quantity ${rawQty} rounds to zero at step ${rules.stepSize}`,
    };
  }
  if (qty < rules.minQty) {
    return {
      ok: false,
      reason: `Quantity ${qty} below venue minimum ${rules.minQty}`,
    };
  }
  if (rules.maxQty > 0 && qty > rules.maxQty) {
    return {
      ok: false,
      reason: `Quantity ${qty} above venue maximum ${rules.maxQty}`,
    };
  }

  const notionalUsd = qty * price;
  if (notionalUsd < rules.minNotionalUsd) {
    return {
      ok: false,
      reason: `Notional $${notionalUsd.toFixed(2)} below venue minimum $${rules.minNotionalUsd}`,
    };
  }

  return { ok: true, qty, notionalUsd };
}

/* ------------------------------------------------------------- fetching */

const CACHE_TTL_MS = 60 * 60_000;
const cache = new Map<string, SymbolRules>();

function cacheKey(venue: string, market: string, symbol: string) {
  return `${venue}:${market}:${symbol}`;
}

type BinanceFilter = {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  minNotional?: string;
  notional?: string;
};

type BinanceSymbolInfo = {
  symbol: string;
  status: string;
  filters: BinanceFilter[];
};

async function getJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBinanceRules(
  baseUrl: string,
  symbol: string,
  market: "spot" | "perp",
  venue: string,
): Promise<SymbolRules> {
  const path = market === "spot" ? "/api/v3/exchangeInfo" : "/fapi/v1/exchangeInfo";
  const d = await getJson<{ symbols: BinanceSymbolInfo[] }>(
    `${baseUrl}${path}?symbol=${symbol}`,
  );

  const info = d.symbols?.find((s) => s.symbol === symbol);
  if (!info) throw new Error(`${symbol} not listed on ${venue} ${market}`);

  const f = (type: string) => info.filters.find((x) => x.filterType === type);
  const price = f("PRICE_FILTER");
  const lot = f("LOT_SIZE");
  // Binance renamed MIN_NOTIONAL to NOTIONAL on spot and kept the old name on
  // futures, so both spellings are checked rather than assuming either.
  const notional = f("NOTIONAL") ?? f("MIN_NOTIONAL");

  const tickSize = Number(price?.tickSize ?? 0);
  const stepSize = Number(lot?.stepSize ?? 0);

  return {
    symbol,
    venue,
    market,
    status: info.status,
    tradable: info.status === "TRADING",
    tickSize,
    stepSize,
    minQty: Number(lot?.minQty ?? 0),
    maxQty: Number(lot?.maxQty ?? 0),
    minNotionalUsd: Number(notional?.minNotional ?? notional?.notional ?? 0),
    pricePrecision: precisionOf(tickSize),
    qtyPrecision: precisionOf(stepSize),
    fetchedAt: Date.now(),
  };
}

type BybitInstrument = {
  symbol: string;
  status: string;
  lotSizeFilter: {
    minOrderQty: string;
    maxOrderQty: string;
    qtyStep?: string;
    basePrecision?: string;
    minNotionalValue?: string;
  };
  priceFilter: { tickSize: string };
};

export async function fetchBybitRules(
  baseUrl: string,
  symbol: string,
  market: "spot" | "perp",
  venue: string,
): Promise<SymbolRules> {
  const category = market === "perp" ? "linear" : "spot";
  const d = await getJson<{
    retCode: number;
    retMsg: string;
    result: { list: BybitInstrument[] };
  }>(`${baseUrl}/v5/market/instruments-info?category=${category}&symbol=${symbol}`);

  if (d.retCode !== 0) throw new Error(d.retMsg || `retCode ${d.retCode}`);
  const info = d.result?.list?.[0];
  if (!info) throw new Error(`${symbol} not listed on ${venue} ${category}`);

  const tickSize = Number(info.priceFilter.tickSize);
  // Bybit uses qtyStep on linear and basePrecision on spot.
  const stepSize = Number(info.lotSizeFilter.qtyStep ?? info.lotSizeFilter.basePrecision ?? 0);

  return {
    symbol,
    venue,
    market,
    status: info.status,
    tradable: info.status === "Trading",
    tickSize,
    stepSize,
    minQty: Number(info.lotSizeFilter.minOrderQty),
    maxQty: Number(info.lotSizeFilter.maxOrderQty),
    minNotionalUsd: Number(info.lotSizeFilter.minNotionalValue ?? 5),
    pricePrecision: precisionOf(tickSize),
    qtyPrecision: precisionOf(stepSize),
    fetchedAt: Date.now(),
  };
}

/**
 * Cached rules lookup.
 *
 * Rules change rarely, so an hour of cache is safe and avoids a round trip on
 * every order. The cache is per-process and simply re-fetches on miss.
 */
export async function getRules(
  venue: string,
  baseUrl: string,
  symbol: string,
  market: "spot" | "perp",
  family: "binance" | "bybit",
): Promise<SymbolRules> {
  const key = cacheKey(venue, market, symbol);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit;

  const rules =
    family === "binance"
      ? await fetchBinanceRules(baseUrl, symbol, market, venue)
      : await fetchBybitRules(baseUrl, symbol, market, venue);

  cache.set(key, rules);
  return rules;
}

/** For tests. */
export function clearRulesCache(): void {
  cache.clear();
}
