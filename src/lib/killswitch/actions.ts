/**
 * Venue-side kill actions.
 *
 * Note what this file adds: the ability to **cancel** orders, in a codebase
 * that still cannot **place** them. That asymmetry is deliberate and is the
 * whole point of ROADMAP sequencing A7 before A4 — the ability to stop must
 * exist, and be tested, before the ability to start.
 *
 * Two mechanisms, and both matter for different failures:
 *
 *   cancelAll        — we are alive and decided to stop. Cancels resting orders
 *                      across every venue we hold a credential for.
 *
 *   dead-man timers  — we are NOT alive. Registered with the exchange, these
 *                      auto-cancel our resting orders if we stop sending
 *                      heartbeats. This is the backstop for the case where our
 *                      own kill switch is unreachable because the box is gone,
 *                      and it is the only mechanism that survives us.
 *
 * A cancel sweep reports per-venue outcomes rather than throwing on the first
 * failure. Halting because one venue is unreachable must still cancel on the
 * two that are.
 */

import { binanceQuery, bybitHeaders } from "@/lib/vault/sign";
import { enabledCredentials, withCredential, type VenueId } from "@/lib/vault/store";

const TIMEOUT_MS = 10_000;

export type VenueSweepResult = {
  venue: VenueId;
  credentialId: string;
  label: string;
  ok: boolean;
  /** What we did, or why we could not. */
  detail: string;
  /** Markets we successfully issued a cancel-all against. */
  cancelled: string[];
};

export type SweepResult = {
  ts: number;
  attempted: number;
  succeeded: number;
  failed: number;
  venues: VenueSweepResult[];
  /** True when there was nothing to do because no credential is enabled. */
  noCredentials: boolean;
};

async function post(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- Binance */

/**
 * Cancel all open orders on Binance.
 *
 * Spot and USDⓈ-M futures are separate APIs and separate order books; cancelling
 * one leaves the other resting. Spot cancel-all is also per-symbol, so we cancel
 * across the symbols we actually trade rather than assuming a global endpoint
 * exists.
 */
async function binanceCancelAll(
  apiKey: string,
  apiSecret: string,
  symbols: string[],
): Promise<{ cancelled: string[]; errors: string[] }> {
  const cancelled: string[] = [];
  const errors: string[] = [];

  // Futures first: leveraged exposure is the side that can liquidate.
  const fq = binanceQuery({}, apiSecret, Date.now());
  const futures = await post(
    `https://fapi.binance.com/fapi/v1/allOpenOrders?${fq}`,
    { method: "DELETE", headers: { "X-MBX-APIKEY": apiKey } },
  ).catch((e) => ({ ok: false, status: 0, body: String(e) }));

  if (futures.ok) cancelled.push("binance:futures:all");
  else errors.push(`futures: ${futures.body.slice(0, 200)}`);

  for (const symbol of symbols) {
    const qs = binanceQuery({ symbol }, apiSecret, Date.now());
    const res = await post(`https://api.binance.com/api/v3/openOrders?${qs}`, {
      method: "DELETE",
      headers: { "X-MBX-APIKEY": apiKey },
    }).catch((e) => ({ ok: false, status: 0, body: String(e) }));

    // -2011 "Unknown order sent" means there was nothing resting, which is
    // success for our purposes — the desired end state is "no open orders".
    if (res.ok || res.body.includes("-2011")) cancelled.push(`binance:spot:${symbol}`);
    else errors.push(`spot ${symbol}: ${res.body.slice(0, 120)}`);
  }

  return { cancelled, errors };
}

/**
 * Register Binance's futures dead-man timer.
 *
 * `countdownTime` is milliseconds; the exchange cancels all open futures orders
 * if we do not call again before it elapses. Passing 0 disables it.
 *
 * This must be re-sent on a heartbeat well inside the window. A timer set once
 * and never refreshed cancels our orders mid-session, which is a worse failure
 * than not having it.
 */
async function binanceDeadMan(
  apiKey: string,
  apiSecret: string,
  countdownMs: number,
  symbols: string[],
): Promise<string[]> {
  const done: string[] = [];
  for (const symbol of symbols) {
    const qs = binanceQuery(
      { symbol, countdownTime: countdownMs },
      apiSecret,
      Date.now(),
    );
    const res = await post(`https://fapi.binance.com/fapi/v1/countdownCancelAll?${qs}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": apiKey },
    }).catch((e) => ({ ok: false, status: 0, body: String(e) }));
    if (res.ok) done.push(symbol);
  }
  return done;
}

/* ------------------------------------------------------------------ Bybit */

async function bybitCancelAll(
  apiKey: string,
  apiSecret: string,
): Promise<{ cancelled: string[]; errors: string[] }> {
  const cancelled: string[] = [];
  const errors: string[] = [];

  for (const category of ["linear", "spot"]) {
    const bodyStr = JSON.stringify({ category });
    const ts = Date.now();
    const res = await post("https://api.bybit.com/v5/order/cancel-all", {
      method: "POST",
      headers: {
        ...bybitHeaders(apiKey, apiSecret, bodyStr, ts),
        "Content-Type": "application/json",
      },
      body: bodyStr,
    }).catch((e) => ({ ok: false, status: 0, body: String(e) }));

    if (res.ok && !res.body.includes('"retCode":1')) cancelled.push(`bybit:${category}`);
    else errors.push(`${category}: ${res.body.slice(0, 160)}`);
  }

  return { cancelled, errors };
}

/**
 * Register Bybit's disconnect-cancel-all.
 *
 * `timeWindow` is seconds. Bybit ties this to the WebSocket connection rather
 * than to a polled heartbeat, so it only takes effect once the engine holds a
 * private socket open — which it does not yet. Registered here so the path
 * exists and is exercised, with that caveat surfaced rather than hidden.
 */
async function bybitDeadMan(
  apiKey: string,
  apiSecret: string,
  windowSeconds: number,
): Promise<boolean> {
  const bodyStr = JSON.stringify({ timeWindow: windowSeconds });
  const ts = Date.now();
  const res = await post("https://api.bybit.com/v5/order/disconnected-cancel-all", {
    method: "POST",
    headers: {
      ...bybitHeaders(apiKey, apiSecret, bodyStr, ts),
      "Content-Type": "application/json",
    },
    body: bodyStr,
  }).catch(() => ({ ok: false, status: 0, body: "" }));
  return res.ok;
}

/* ------------------------------------------------------------------ sweep */

/**
 * Cancel every resting order on every enabled credential.
 *
 * Runs all venues concurrently and never throws: each venue's outcome is
 * reported individually, because "Bybit was unreachable" must not stop us
 * cancelling on Binance.
 */
export async function cancelAll(symbols: string[]): Promise<SweepResult> {
  const creds = await enabledCredentials();

  if (creds.length === 0) {
    return {
      ts: Date.now(),
      attempted: 0,
      succeeded: 0,
      failed: 0,
      venues: [],
      noCredentials: true,
    };
  }

  const results = await Promise.all(
    creds.map(async (c): Promise<VenueSweepResult> => {
      const base = { venue: c.venue, credentialId: c.id, label: c.label };
      try {
        if (c.venue === "binance") {
          const r = await withCredential(c.id, (s) =>
            binanceCancelAll(s.apiKey, s.apiSecret, symbols),
          );
          return {
            ...base,
            ok: r.errors.length === 0,
            detail:
              r.errors.length === 0
                ? `Cancelled across ${r.cancelled.length} markets`
                : r.errors.join("; "),
            cancelled: r.cancelled,
          };
        }

        if (c.venue === "bybit") {
          const r = await withCredential(c.id, (s) =>
            bybitCancelAll(s.apiKey, s.apiSecret),
          );
          return {
            ...base,
            ok: r.errors.length === 0,
            detail:
              r.errors.length === 0
                ? `Cancelled across ${r.cancelled.length} categories`
                : r.errors.join("; "),
            cancelled: r.cancelled,
          };
        }

        return {
          ...base,
          ok: false,
          detail: "Hyperliquid cancel is not implemented yet",
          cancelled: [],
        };
      } catch (e) {
        return {
          ...base,
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
          cancelled: [],
        };
      }
    }),
  );

  return {
    ts: Date.now(),
    attempted: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    venues: results,
    noCredentials: false,
  };
}

export type DeadManResult = {
  venue: VenueId;
  credentialId: string;
  ok: boolean;
  detail: string;
};

/**
 * Register (or clear) exchange-side dead-man timers.
 *
 * Pass 0 to clear. These are the only protection that survives our own process
 * dying, so they belong on a heartbeat once an order path exists — and they are
 * useless if registered once and never refreshed.
 */
export async function registerDeadMan(
  countdownMs: number,
  symbols: string[],
): Promise<DeadManResult[]> {
  const creds = await enabledCredentials();

  return Promise.all(
    creds.map(async (c): Promise<DeadManResult> => {
      try {
        if (c.venue === "binance") {
          const done = await withCredential(c.id, (s) =>
            binanceDeadMan(s.apiKey, s.apiSecret, countdownMs, symbols),
          );
          return {
            venue: c.venue,
            credentialId: c.id,
            ok: done.length > 0,
            detail:
              done.length > 0
                ? `Registered on ${done.length} symbols (${countdownMs}ms)`
                : "No symbols accepted the timer — key likely lacks futures trade permission",
          };
        }

        if (c.venue === "bybit") {
          const ok = await withCredential(c.id, (s) =>
            bybitDeadMan(s.apiKey, s.apiSecret, Math.round(countdownMs / 1000)),
          );
          return {
            venue: c.venue,
            credentialId: c.id,
            ok,
            detail: ok
              ? "Registered — takes effect once a private WebSocket is held open"
              : "Rejected — key likely lacks trade permission",
          };
        }

        return {
          venue: c.venue,
          credentialId: c.id,
          ok: false,
          detail: "Not implemented for this venue",
        };
      } catch (e) {
        return {
          venue: c.venue,
          credentialId: c.id,
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
}
