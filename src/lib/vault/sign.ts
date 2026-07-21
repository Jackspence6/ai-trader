/**
 * Request signing for authenticated venue calls.
 *
 * Every venue signs differently and every one of them will silently reject a
 * subtly-wrong signature with a generic auth error, which makes signing bugs
 * unusually expensive to diagnose. So each scheme here is implemented against
 * the venue's documented example and asserted against that published test
 * vector in the tests — the only way to know the implementation is right
 * without a live key.
 */

import { createHmac } from "node:crypto";

/**
 * Binance: HMAC-SHA256 over the raw query string, appended as `signature`.
 *
 * The critical detail is that the signature covers the query string *exactly*
 * as transmitted. Re-encoding or reordering parameters after signing produces a
 * valid-looking request that the venue rejects, so callers must send the string
 * that was signed rather than rebuilding it from a parsed object.
 */
export function signBinance(queryString: string, secret: string): string {
  return createHmac("sha256", secret).update(queryString).digest("hex");
}

/**
 * Build a Binance signed query string.
 *
 * Returns the full string including the signature, ready to append to a URL.
 * Parameter order is preserved as given.
 */
export function binanceQuery(
  params: Record<string, string | number>,
  secret: string,
  timestamp: number,
  recvWindow = 5000,
): string {
  const withAuth: Record<string, string | number> = {
    ...params,
    recvWindow,
    timestamp,
  };

  const qs = Object.entries(withAuth)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

  return `${qs}&signature=${signBinance(qs, secret)}`;
}

/**
 * Bybit v5: HMAC-SHA256 over `timestamp + apiKey + recvWindow + payload`.
 *
 * Note the payload is the raw query string for GET and the raw JSON body for
 * POST — concatenated without separators. Getting the concatenation order wrong
 * is the usual Bybit signing bug.
 */
export function signBybit(
  timestamp: number,
  apiKey: string,
  recvWindow: number,
  payload: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}${apiKey}${recvWindow}${payload}`)
    .digest("hex");
}

export type BybitAuthHeaders = {
  "X-BAPI-API-KEY": string;
  "X-BAPI-TIMESTAMP": string;
  "X-BAPI-RECV-WINDOW": string;
  "X-BAPI-SIGN": string;
};

export function bybitHeaders(
  apiKey: string,
  secret: string,
  payload: string,
  timestamp: number,
  recvWindow = 5000,
): BybitAuthHeaders {
  return {
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-TIMESTAMP": String(timestamp),
    "X-BAPI-RECV-WINDOW": String(recvWindow),
    "X-BAPI-SIGN": signBybit(timestamp, apiKey, recvWindow, payload, secret),
  };
}
