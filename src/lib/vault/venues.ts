/**
 * Authenticated venue calls — read-only.
 *
 * Nothing in this file can place, amend or cancel an order. That is not an
 * oversight: ROADMAP sequences credentials (A2/A3) ahead of the OMS (A4) and
 * ahead of the real kill switch (A7), and the ability to stop must exist before
 * the ability to start. Until then the authenticated surface is deliberately
 * limited to asking questions.
 *
 * Two calls per venue:
 *   checkPermissions — what this key is allowed to do, including the withdrawal
 *                      flag that decides whether we will use it at all
 *   fetchBalances    — what the account actually holds
 */

import { binanceQuery, bybitHeaders } from "./sign";
import type { Permissions, VenueId } from "./store";

const TIMEOUT_MS = 10_000;

export type Balance = {
  asset: string;
  free: number;
  locked: number;
  total: number;
};

export type VenueAccount = {
  venue: VenueId;
  balances: Balance[];
  /** Total marked to USD. Null when we could not price everything. */
  totalUsd: number | null;
  fetchedAt: number;
};

export class VenueAuthError extends Error {
  constructor(
    message: string,
    readonly venue: VenueId,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VenueAuthError";
  }
}

async function fetchJson(url: string, init: RequestInit, venue: VenueId): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new VenueAuthError(
        `${venue} returned a non-JSON response (HTTP ${res.status})`,
        venue,
        res.status,
      );
    }

    if (!res.ok) {
      // Venue error bodies carry the useful detail; the status alone is rarely
      // enough to tell a bad signature from a missing permission.
      const msg =
        (body as { msg?: string; retMsg?: string })?.msg ??
        (body as { retMsg?: string })?.retMsg ??
        `HTTP ${res.status}`;
      throw new VenueAuthError(msg, venue, res.status);
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- Binance */

type BinanceRestrictions = {
  enableReading?: boolean;
  enableWithdrawals?: boolean;
  enableSpotAndMarginTrading?: boolean;
  enableFutures?: boolean;
  ipRestrict?: boolean;
};

export async function binancePermissions(
  apiKey: string,
  apiSecret: string,
): Promise<Permissions> {
  const qs = binanceQuery({}, apiSecret, Date.now());
  const body = (await fetchJson(
    `https://api.binance.com/sapi/v1/account/apiRestrictions?${qs}`,
    { headers: { "X-MBX-APIKEY": apiKey } },
    "binance",
  )) as BinanceRestrictions;

  return {
    // Default to `true` when the field is absent. An unreadable withdrawal
    // flag must fail closed — assuming "probably fine" here is the one place
    // where being wrong empties the account.
    withdrawals: body.enableWithdrawals ?? true,
    reading: body.enableReading ?? false,
    spotTrading: body.enableSpotAndMarginTrading ?? false,
    futuresTrading: body.enableFutures ?? false,
    ipRestricted: body.ipRestrict ?? false,
    checkedAt: Date.now(),
  };
}

type BinanceAccount = {
  balances: { asset: string; free: string; locked: string }[];
};

export async function binanceBalances(
  apiKey: string,
  apiSecret: string,
): Promise<Balance[]> {
  const qs = binanceQuery({}, apiSecret, Date.now());
  const body = (await fetchJson(
    `https://api.binance.com/api/v3/account?${qs}`,
    { headers: { "X-MBX-APIKEY": apiKey } },
    "binance",
  )) as BinanceAccount;

  return (body.balances ?? [])
    .map((b) => ({
      asset: b.asset,
      free: Number(b.free),
      locked: Number(b.locked),
      total: Number(b.free) + Number(b.locked),
    }))
    .filter((b) => b.total > 0);
}

/* ------------------------------------------------------------------ Bybit */

type BybitEnvelope<T> = { retCode: number; retMsg: string; result: T };

type BybitApiKeyInfo = {
  permissions?: Record<string, string[]>;
  ips?: string[];
  readOnly?: number;
};

export async function bybitPermissions(
  apiKey: string,
  apiSecret: string,
): Promise<Permissions> {
  const ts = Date.now();
  const body = (await fetchJson(
    "https://api.bybit.com/v5/user/query-api",
    { headers: bybitHeaders(apiKey, apiSecret, "", ts) },
    "bybit",
  )) as BybitEnvelope<BybitApiKeyInfo>;

  if (body.retCode !== 0) {
    throw new VenueAuthError(body.retMsg || `retCode ${body.retCode}`, "bybit");
  }

  const perms = body.result?.permissions ?? {};
  const all = Object.values(perms).flat();
  const has = (needle: string) =>
    all.some((p) => p.toLowerCase().includes(needle.toLowerCase()));

  // Bybit expresses withdrawal as a permission string rather than a boolean.
  // If the permissions object is missing entirely we cannot prove withdrawals
  // are off, so we treat that as blocked rather than as absent.
  const permissionsKnown = Object.keys(perms).length > 0;

  return {
    withdrawals: permissionsKnown ? has("withdraw") : true,
    reading: permissionsKnown,
    spotTrading: has("spot"),
    futuresTrading: has("derivative") || has("contract"),
    ipRestricted: (body.result?.ips ?? []).length > 0,
    checkedAt: Date.now(),
  };
}

type BybitWalletBalance = {
  list: { coin: { coin: string; walletBalance: string; locked: string }[] }[];
};

export async function bybitBalances(
  apiKey: string,
  apiSecret: string,
): Promise<Balance[]> {
  const ts = Date.now();
  const qs = "accountType=UNIFIED";
  const body = (await fetchJson(
    `https://api.bybit.com/v5/account/wallet-balance?${qs}`,
    { headers: bybitHeaders(apiKey, apiSecret, qs, ts) },
    "bybit",
  )) as BybitEnvelope<BybitWalletBalance>;

  if (body.retCode !== 0) {
    throw new VenueAuthError(body.retMsg || `retCode ${body.retCode}`, "bybit");
  }

  const out: Balance[] = [];
  for (const account of body.result?.list ?? []) {
    for (const c of account.coin ?? []) {
      const total = Number(c.walletBalance);
      if (!(total > 0)) continue;
      const locked = Number(c.locked) || 0;
      out.push({ asset: c.coin, free: total - locked, locked, total });
    }
  }
  return out;
}

/* ------------------------------------------------------------- dispatcher */

export async function checkPermissions(
  venue: VenueId,
  apiKey: string,
  apiSecret: string,
): Promise<Permissions> {
  switch (venue) {
    case "binance":
      return binancePermissions(apiKey, apiSecret);
    case "bybit":
      return bybitPermissions(apiKey, apiSecret);
    case "hyperliquid":
      // Hyperliquid has a different model: API wallets are separate keys that
      // are structurally incapable of withdrawing — withdrawals require the
      // master wallet's signature. That is a stronger guarantee than a
      // permission flag, but it is not one we can verify from an endpoint, so
      // it is asserted here rather than checked.
      throw new VenueAuthError(
        "Hyperliquid uses API wallets, which cannot withdraw by construction. " +
          "Support for it is not implemented yet.",
        "hyperliquid",
      );
  }
}

export async function fetchBalances(
  venue: VenueId,
  apiKey: string,
  apiSecret: string,
): Promise<Balance[]> {
  switch (venue) {
    case "binance":
      return binanceBalances(apiKey, apiSecret);
    case "bybit":
      return bybitBalances(apiKey, apiSecret);
    case "hyperliquid":
      throw new VenueAuthError("Hyperliquid is not implemented yet", "hyperliquid");
  }
}

/**
 * Mark balances to USD using live prices.
 *
 * Stablecoins are treated as $1. That is an approximation and occasionally a
 * wrong one — the L3 strategy exists precisely because they depeg — but the
 * error is basis points on a NAV figure, and the alternative is refusing to
 * value the account at all.
 */
const STABLES = new Set(["USDT", "USDC", "BUSD", "DAI", "FDUSD", "TUSD"]);

export function markToUsd(
  balances: Balance[],
  prices: Map<string, number>,
): { totalUsd: number | null; unpriced: string[] } {
  let total = 0;
  const unpriced: string[] = [];

  for (const b of balances) {
    if (STABLES.has(b.asset)) {
      total += b.total;
      continue;
    }
    const px = prices.get(b.asset);
    if (px === undefined) {
      unpriced.push(b.asset);
      continue;
    }
    total += b.total * px;
  }

  return { totalUsd: total, unpriced };
}
