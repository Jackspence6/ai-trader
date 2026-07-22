/**
 * Currency conversion that always answers.
 *
 * The dashboard shows every figure in ZAR, USD and EUR, and the standing rule
 * is that a conversion must NEVER read "not available". A live rate is best, but
 * a missing rate is not an acceptable outcome for a number the operator is
 * trying to read at a glance.
 *
 * So this service degrades in steps, and always returns a usable rate:
 *
 *   1. **Live** — a fresh fix from Frankfurter (ECB reference rates, free).
 *   2. **Cached** — the last live fix we successfully fetched, kept in the KV
 *      store. Survives a restart and a provider outage.
 *   3. **Reference** — a hard-coded seed, only ever reached on a brand-new
 *      deployment whose first fetch has not landed yet. Clearly labelled so it
 *      is never mistaken for a live rate.
 *
 * Everything is stored as **USD per 1 unit** of each currency, because USD is
 * the fund's settlement currency and the value every balance is anchored to.
 * USD per ZAR is a small number (~0.06); USD per EUR is ~1.08.
 */

import { readJson, writeJson } from "@/lib/store/kv";
import type { CurrencyCode, FxRates } from "@/lib/market/fx";

const CACHE_KEY = "fx_rate_cache";
const TIMEOUT_MS = 8_000;

/** Currencies the UI can display in. USD is always 1. */
export const DISPLAY_CURRENCIES = ["USD", "ZAR", "EUR"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

/** Every currency we need a USD rate for (display + funding currencies). */
const TRACKED = ["ZAR", "EUR", "GBP"] as const;

/**
 * Last-resort seed rates, USD per 1 unit. Only used before the first live fetch
 * on a fresh deployment. Approximate on purpose — being labelled "reference" is
 * what keeps them honest, not their precision.
 */
const SEED_USD_PER: Record<string, number> = {
  USD: 1,
  ZAR: 0.06, // ~R16.7/USD
  EUR: 1.08,
  GBP: 1.27,
};

export type RateSource = "live" | "cached" | "reference";

export type RateTable = {
  /** USD per 1 unit of each currency. USD is 1. */
  usdPer: Record<string, number>;
  source: RateSource;
  /** ECB fix date for a live rate, or when the cache was last refreshed. */
  asOf: string;
  ts: number;
};

type CachedTable = { usdPer: Record<string, number>; asOf: string; ts: number };

async function fetchLive(): Promise<CachedTable | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.frankfurter.app/latest?base=USD&symbols=${TRACKED.join(",")}`,
      { signal: ctrl.signal, cache: "no-store" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { date: string; rates: Record<string, number> };

    // Frankfurter base=USD gives "units of X per 1 USD". We want USD per 1 X,
    // which is the reciprocal.
    const usdPer: Record<string, number> = { USD: 1 };
    for (const cur of TRACKED) {
      const perUsd = data.rates[cur];
      if (perUsd && Number.isFinite(perUsd) && perUsd > 0) usdPer[cur] = 1 / perUsd;
    }
    return { usdPer, asOf: data.date, ts: Date.now() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get a rate table, refreshing from the provider and falling back through the
 * cache to the seed. A successful live fetch is written to the cache so the next
 * outage has something recent to serve.
 */
export async function getRateTable(): Promise<RateTable> {
  const live = await fetchLive();
  if (live) {
    // Best effort — a cache write that fails must not fail the conversion.
    try {
      await writeJson<CachedTable>(CACHE_KEY, live);
    } catch {
      /* ignore */
    }
    return { ...live, source: "live" };
  }

  const cached = await readJson<CachedTable>(CACHE_KEY).catch(() => null);
  if (cached?.usdPer?.USD) {
    return { ...cached, source: "cached" };
  }

  return { usdPer: { ...SEED_USD_PER }, source: "reference", asOf: "seed", ts: Date.now() };
}

/** USD per 1 unit of `currency` from a table, falling back to the seed. */
export function usdPerUnit(table: RateTable, currency: string): number {
  return table.usdPer[currency] ?? SEED_USD_PER[currency] ?? 0;
}

/** Convert an amount between two currencies using a table. */
export function convert(
  table: RateTable,
  amount: number,
  from: string,
  to: string,
): number {
  const fromUsd = usdPerUnit(table, from);
  const toUsd = usdPerUnit(table, to);
  if (!toUsd) return 0;
  return (amount * fromUsd) / toUsd;
}

/**
 * A USD amount rendered in every display currency at once, plus the provenance
 * of the rates used. This is the shape the UI reads so it can show all three
 * without recomputing.
 */
export type MultiCurrency = {
  usd: number;
  values: Record<DisplayCurrency, number>;
  source: RateSource;
  asOf: string;
};

export function inDisplayCurrencies(table: RateTable, usd: number): MultiCurrency {
  const values = Object.fromEntries(
    DISPLAY_CURRENCIES.map((c) => [c, convert(table, usd, "USD", c)]),
  ) as Record<DisplayCurrency, number>;
  return { usd, values, source: table.source, asOf: table.asOf };
}

/**
 * Adapt a rate table to the display-currency layer's `FxRates` shape, which is
 * quoted as "units per 1 USD" (the reciprocal of what we store). This is the
 * single source the `/api/fx` switcher and the `Money` component read, so a
 * conversion on screen can never come back unavailable — the worst case is a
 * clearly-labelled reference rate.
 */
export function toFxRates(table: RateTable): FxRates {
  const perUsd = (c: CurrencyCode): number => {
    if (c === "USD") return 1;
    const usdPer = table.usdPer[c] ?? SEED_USD_PER[c];
    return usdPer && usdPer > 0 ? 1 / usdPer : 0;
  };
  return {
    base: "USD",
    rates: {
      USD: 1,
      ZAR: perUsd("ZAR"),
      EUR: perUsd("EUR"),
      GBP: perUsd("GBP"),
    },
    updatedAt: table.ts,
    fetchedAt: table.ts,
    source: table.source,
    degraded: false,
  };
}
