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
  /**
   * Where the rate came from. A live fix is best; a cached last-known fix
   * survives a provider outage; a reference seed only appears before the first
   * fetch on a fresh deployment. All three are usable — the guarantee is that a
   * conversion is never unavailable, so this is provenance, not a failure flag.
   */
  source: "live" | "cached" | "reference";
  /**
   * Retained for compatibility. Now always false: we never zero the rates,
   * because a rand figure that silently reads "unavailable" is exactly the
   * number the operator is trying to see.
   */
  degraded: boolean;
};

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
