/**
 * Forex market data.
 *
 * Structurally different from the crypto feed, and the differences are the
 * point rather than an inconvenience:
 *
 *   - **No funding rate.** Crypto perps pay funding; spot FX does not. The
 *     carry in forex is the *interest-rate differential*, which is not in the
 *     price feed — it comes from central-bank policy rates. So a carry signal
 *     here is built from rates we carry as reference data, not scraped live.
 *   - **No continuous book.** FX trades business days only. A weekend "price"
 *     is Friday's close, and the feed says so rather than implying a live quote.
 *   - **Priced in pips.** A move that is trivial in percent terms is meaningful
 *     in FX, which is exactly why the asset class is quoted the way it is.
 *
 * Prices come from Frankfurter (ECB reference rates, free, no key). That is a
 * daily reference fix, not a live dealing rate — good enough to score signals
 * and mark paper positions, and honestly labelled as end-of-day so nothing
 * downstream mistakes it for a tradeable tick.
 */

export type FxPair = {
  /** e.g. "EURUSD". Base first, quote second. */
  symbol: string;
  base: string;
  quote: string;
};

/**
 * The pairs we follow.
 *
 * The G10 majors plus two liquid high-carry pairs (ZAR, MXN). Majors are the
 * deepest and cheapest to trade; the high-yielders are where the carry
 * actually lives, and they are admitted only with deliberately punitive
 * modelled spreads — the backtest replays these exact pairs at those tolls,
 * so a pair earns capital only if its carry clears its own cost of passage.
 */
export const FX_PAIRS: FxPair[] = [
  { symbol: "EURUSD", base: "EUR", quote: "USD" },
  { symbol: "GBPUSD", base: "GBP", quote: "USD" },
  { symbol: "USDJPY", base: "USD", quote: "JPY" },
  { symbol: "AUDUSD", base: "AUD", quote: "USD" },
  { symbol: "USDCAD", base: "USD", quote: "CAD" },
  { symbol: "USDCHF", base: "USD", quote: "CHF" },
  { symbol: "USDZAR", base: "USD", quote: "ZAR" },
  // G10 completions and one more liquid high-carry pair, added 2026-07 to
  // widen the carry scan's menu. Same doctrine as ZAR: the wide modelled
  // spread is the toll, and the pair earns capital only if the backtest —
  // which replays these exact pairs — says the carry clears it.
  { symbol: "NZDUSD", base: "NZD", quote: "USD" },
  { symbol: "USDSEK", base: "USD", quote: "SEK" },
  { symbol: "USDMXN", base: "USD", quote: "MXN" },
];

/**
 * Reference central-bank policy rates, annualised, as of 2026-07.
 *
 * Carried as data, not fetched, because policy rates change on scheduled
 * meeting dates a handful of times a year — a live feed would be almost all
 * cache and no freshness. These are updated by hand when a central bank moves,
 * and the date they were last set is recorded so staleness is visible rather
 * than assumed.
 *
 * The carry on a pair is `base_rate − quote_rate`: hold the higher-yielding
 * currency, earn the difference, minus whatever the broker skims on the swap.
 */
export const POLICY_RATES: Record<string, number> = {
  USD: 0.045,
  EUR: 0.025,
  GBP: 0.0425,
  JPY: 0.005,
  AUD: 0.0385,
  CAD: 0.0275,
  CHF: 0.01,
  ZAR: 0.0725,
  NZD: 0.0225,
  SEK: 0.0175,
  MXN: 0.0725,
};

export const POLICY_RATES_AS_OF = "2026-07-01";

export type FxQuote = {
  symbol: string;
  base: string;
  quote: string;
  rate: number;
  /** base_rate − quote_rate, annualised. The carry before broker costs. */
  carryApr: number;
  /** ECB reference date for this rate. */
  asOfDate: string;
  /** True when the latest fix is older than a business day — i.e. a weekend. */
  stale: boolean;
  ts: number;
};

type FrankfurterLatest = {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
};

const TIMEOUT_MS = 8_000;

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

/** Carry on a pair, annualised, before broker swap costs. */
export function carryApr(base: string, quote: string): number {
  const b = POLICY_RATES[base];
  const q = POLICY_RATES[quote];
  if (b === undefined || q === undefined) return 0;
  return b - q;
}

/**
 * Fetch the current reference rates for every followed pair.
 *
 * One call to the USD table covers every USD pair in either direction;
 * non-USD-quoted pairs (USDJPY etc.) invert as needed.
 */
export async function fetchFxQuotes(): Promise<FxQuote[]> {
  const symbols = [...new Set(FX_PAIRS.flatMap((p) => [p.base, p.quote]))]
    .filter((c) => c !== "USD")
    .join(",");

  const data = await getJson<FrankfurterLatest>(
    `https://api.frankfurter.app/latest?base=USD&symbols=${symbols}`,
  );

  // A fix older than ~3 days means a weekend or holiday — the price is real but
  // not live, and saying so stops a strategy treating a stale weekend rate as a
  // tradeable one.
  const fixAge = Date.now() - Date.parse(`${data.date}T00:00:00Z`);
  const stale = fixAge > 3 * 24 * 60 * 60_000;

  const now = Date.now();
  const out: FxQuote[] = [];

  for (const p of FX_PAIRS) {
    // Frankfurter base=USD gives "units of X per 1 USD" for each symbol.
    const usdPerBase = p.base === "USD" ? 1 : data.rates[p.base];
    const usdPerQuote = p.quote === "USD" ? 1 : data.rates[p.quote];
    if (!usdPerBase || !usdPerQuote) continue;

    // Frankfurter's base=USD table gives "units of X per 1 USD". The pair rate
    // is quote-per-base:
    //   EURUSD (quote USD): USD per 1 EUR = usdPerBase
    //   USDJPY (base USD):  JPY per 1 USD = the JPY table value directly
    //   cross:              (X per USD ratio)
    const rate =
      p.quote === "USD"
        ? usdPerBase
        : p.base === "USD"
          ? usdPerQuote
          : usdPerBase / usdPerQuote;

    out.push({
      symbol: p.symbol,
      base: p.base,
      quote: p.quote,
      rate,
      carryApr: carryApr(p.base, p.quote),
      asOfDate: data.date,
      stale,
      ts: now,
    });
  }

  return out;
}

/** Daily closes for one pair, for volatility and trend signals. */
export async function fetchFxHistory(
  symbol: string,
  days = 180,
): Promise<{ t: number; rate: number }[]> {
  const pair = FX_PAIRS.find((p) => p.symbol === symbol);
  if (!pair) throw new Error(`Unknown FX pair: ${symbol}`);

  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  const nonUsd = pair.base === "USD" ? pair.quote : pair.base;
  const data = await getJson<{ rates: Record<string, Record<string, number>> }>(
    `https://api.frankfurter.app/${from}..${to}?base=USD&symbols=${nonUsd}`,
  );

  return Object.keys(data.rates)
    .sort()
    .map((date) => {
      // For a USD-quoted pair, `usdPer` is USD-per-unit (that IS the rate).
      // For a USD-based pair (USDJPY), it is units-per-USD (also the rate).
      const rate = data.rates[date][nonUsd];
      return { t: Date.parse(`${date}T00:00:00Z`), rate };
    });
}
