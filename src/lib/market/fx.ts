/**
 * Foreign exchange rates.
 *
 * The fund's books are kept in USD because that is the currency the venues
 * actually settle in — every balance, fee and funding payment arrives as USDT
 * or USDC. Displaying in ZAR or EUR is a *presentation* concern applied at the
 * last moment.
 *
 * That distinction matters more than it sounds. If we stored ZAR, every
 * historical PnL number would silently change whenever the rand moved, and we
 * would not be able to tell trading performance apart from currency movement.
 * So: store USD, convert on render, and always show the rate and its age.
 */

export const CURRENCIES = {
  USD: { code: "USD", symbol: "$", name: "US Dollar", locale: "en-US" },
  ZAR: { code: "ZAR", symbol: "R", name: "South African Rand", locale: "en-ZA" },
  EUR: { code: "EUR", symbol: "€", name: "Euro", locale: "de-DE" },
  GBP: { code: "GBP", symbol: "£", name: "Pound Sterling", locale: "en-GB" },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_LIST = Object.values(CURRENCIES);

export type FxRates = {
  /** Base is always USD. `rates.ZAR = 18.4` means 1 USD = 18.4 ZAR. */
  base: "USD";
  rates: Record<CurrencyCode, number>;
  /** When the provider last updated (ms epoch). */
  updatedAt: number;
  /** When we fetched it (ms epoch). */
  fetchedAt: number;
  /** True when we fell back to identity rates because the provider failed. */
  degraded: boolean;
};

/** Identity rates — used only as an explicitly-degraded fallback. */
export function identityRates(): FxRates {
  return {
    base: "USD",
    rates: { USD: 1, ZAR: 0, EUR: 0, GBP: 0 },
    updatedAt: 0,
    fetchedAt: Date.now(),
    degraded: true,
  };
}

type ErApiResponse = {
  result: string;
  time_last_update_unix: number;
  rates: Record<string, number>;
};

/**
 * Fetch USD-based rates.
 *
 * On failure we return `degraded: true` with zeroed non-USD rates rather than
 * stale or invented numbers. The UI then refuses to show a converted figure and
 * says so — showing a plausible-looking wrong rand number would be worse than
 * showing none, because someone would act on it.
 */
export async function fetchFxRates(): Promise<FxRates> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as ErApiResponse;
    if (d.result !== "success") throw new Error("provider reported failure");

    const pick = (c: CurrencyCode) =>
      Number.isFinite(d.rates[c]) && d.rates[c] > 0 ? d.rates[c] : 0;

    return {
      base: "USD",
      rates: { USD: 1, ZAR: pick("ZAR"), EUR: pick("EUR"), GBP: pick("GBP") },
      updatedAt: d.time_last_update_unix * 1000,
      fetchedAt: Date.now(),
      degraded: false,
    };
  } catch {
    return identityRates();
  } finally {
    clearTimeout(timer);
  }
}

/** Convert a USD amount into the target currency. Returns null if unavailable. */
export function convertFromUsd(
  usd: number,
  to: CurrencyCode,
  fx: FxRates,
): number | null {
  const r = fx.rates[to];
  if (!Number.isFinite(r) || r <= 0) return null;
  return usd * r;
}
