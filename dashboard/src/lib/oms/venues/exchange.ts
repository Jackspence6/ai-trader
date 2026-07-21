/**
 * Exchange venue adapter — real orders against a real matching engine.
 *
 * This is the first code in the system that can place an order. Everything
 * about it is shaped by that.
 *
 * **Why this is safe to build now:** it is written against exchange *testnets*,
 * which are real matching engines with real order books, real queue position,
 * real rejections and no real money. And because testnet and mainnet differ
 * only in base URL, proving this on testnet genuinely proves the mainnet path —
 * which is the entire reason to build it this way round rather than writing a
 * mainnet adapter and hoping.
 *
 * What testnet gives you that a simulator cannot:
 *   - Your order actually rests in a book and actually queues.
 *   - The venue rejects it for reasons you did not anticipate.
 *   - Precision, min-notional and rate limits bite for real.
 *   - Partial fills happen because someone else's order was in front of yours.
 *
 * What it still does NOT give you, and no testnet can:
 *   - Real adverse selection. Testnet flow is not real flow, so the fills you
 *     get there are not the fills you would get in a real market.
 *   - Real liquidity. Testnet books are thin and sometimes absurd.
 * So testnet is strong evidence about *our code* and weak evidence about
 * *our edge*. Both matter; they are not the same thing.
 */

import { binanceQuery, bybitHeaders } from "@/lib/vault/sign";
import type { Fill } from "@/lib/portfolio/positions";
import {
  newOrderId,
  type Order,
  type OrderIntent,
  type SubmitResult,
  type Venue,
} from "../types";
import {
  checkMainnetGate,
  type VenueEndpoint,
  type VenueEnvironment,
} from "./environment";
import { getRules, quantisePrice, validateOrder } from "./symbols";

const TIMEOUT_MS = 15_000;

export type ExchangeVenueOptions = {
  endpoint: VenueEndpoint;
  apiKey: string;
  apiSecret: string;
  /** Environment the credential was stored under. Must match the endpoint. */
  credentialEnvironment: VenueEnvironment;
  /** Explicit per-call-site confirmation, required for mainnet only. */
  confirmMainnet?: boolean;
  /** Called before every order leaves the process. */
  onSubmit?: (line: string) => void;
};

type HttpResult = { ok: boolean; status: number; body: unknown; raw: string };

async function http(
  url: string,
  init: RequestInit,
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    const raw = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, raw };
  } finally {
    clearTimeout(timer);
  }
}

function symbolFor(asset: string): string {
  return `${asset}USDT`;
}

export class ExchangeVenue implements Venue {
  readonly id: string;
  readonly isLive: boolean;

  private opts: ExchangeVenueOptions;
  private submitted: Order[] = [];

  constructor(opts: ExchangeVenueOptions) {
    this.opts = opts;
    this.id = opts.endpoint.id;
    // `isLive` means "real money", not "reaches a real exchange". Testnet
    // reaches a real exchange and is deliberately not live — the distinction is
    // rendered prominently in the UI and must not blur.
    this.isLive = opts.endpoint.environment === "mainnet";
  }

  private base(market: "spot" | "perp"): string {
    return market === "spot" ? this.opts.endpoint.spotBase : this.opts.endpoint.perpBase;
  }

  /**
   * The gate every order passes before anything leaves the process.
   *
   * Checked per order rather than once at construction: a long-lived venue
   * object created while mainnet was permitted must not keep that permission
   * after the environment changes.
   */
  private guard(): { ok: true } | { ok: false; reason: string } {
    const gate = checkMainnetGate(
      this.opts.endpoint,
      this.opts.credentialEnvironment,
      this.opts.confirmMainnet ?? false,
    );
    if (gate.allowed) return { ok: true };
    return {
      ok: false,
      reason: `Refused at mainnet gate ${gate.failedGate}/3 — ${gate.reason}`,
    };
  }

  async submit(intent: OrderIntent): Promise<SubmitResult> {
    const guard = this.guard();
    if (!guard.ok) return { ok: false, reason: guard.reason };

    const symbol = symbolFor(intent.asset);
    const base = this.base(intent.market);

    let rules;
    try {
      rules = await getRules(
        this.opts.endpoint.id,
        base,
        symbol,
        intent.market,
        this.opts.endpoint.family,
      );
    } catch (e) {
      return {
        ok: false,
        reason: `Could not load trading rules for ${symbol}: ${e instanceof Error ? e.message : e}`,
      };
    }

    // Reference price for the min-notional check. A market order has no price,
    // so the venue's own mark is the honest benchmark.
    let refPrice: number;
    try {
      refPrice = await this.referencePrice(intent.market, symbol);
    } catch (e) {
      return {
        ok: false,
        reason: `Could not price ${symbol}: ${e instanceof Error ? e.message : e}`,
      };
    }

    const check = validateOrder(intent.qty, refPrice, rules);
    if (!check.ok) return { ok: false, reason: check.reason };

    const limitPrice =
      intent.type === "limit" && intent.limitPrice !== undefined
        ? quantisePrice(intent.limitPrice, intent.side, rules)
        : undefined;

    // Logged BEFORE the network call. If the process dies mid-submit, the log
    // is the only record that an order may exist at the venue — and "may exist"
    // is the state reconciliation has to resolve.
    this.opts.onSubmit?.(
      `SUBMIT ${this.opts.endpoint.id} ${intent.side} ${check.qty} ${symbol} ` +
        `${intent.market} ${intent.type}${limitPrice ? ` @ ${limitPrice}` : ""} ` +
        `[${this.opts.endpoint.environment}]`,
    );

    const started = Date.now();
    const result =
      this.opts.endpoint.family === "binance"
        ? await this.submitBinance(intent, symbol, check.qty, limitPrice)
        : await this.submitBybit(intent, symbol, check.qty, limitPrice);

    if (!result.ok) return result;

    result.order.timings.submittedMs = 0;
    result.order.timings.acknowledgedMs = Date.now() - started;
    result.order.timings.completeMs =
      result.order.status === "filled" ? Date.now() - started : null;

    this.submitted.push(result.order);
    return result;
  }

  private async referencePrice(market: "spot" | "perp", symbol: string): Promise<number> {
    const base = this.base(market);
    const url =
      this.opts.endpoint.family === "binance"
        ? market === "spot"
          ? `${base}/api/v3/ticker/price?symbol=${symbol}`
          : `${base}/fapi/v1/ticker/price?symbol=${symbol}`
        : `${base}/v5/market/tickers?category=${market === "perp" ? "linear" : "spot"}&symbol=${symbol}`;

    const r = await http(url, {});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    if (this.opts.endpoint.family === "binance") {
      const p = Number((r.body as { price?: string })?.price);
      if (!(p > 0)) throw new Error("no price in response");
      return p;
    }

    const list = (r.body as { result?: { list?: { lastPrice: string }[] } })?.result?.list;
    const p = Number(list?.[0]?.lastPrice);
    if (!(p > 0)) throw new Error("no price in response");
    return p;
  }

  /* -------------------------------------------------------------- Binance */

  private async submitBinance(
    intent: OrderIntent,
    symbol: string,
    qty: number,
    limitPrice?: number,
  ): Promise<SubmitResult> {
    const base = this.base(intent.market);
    const path = intent.market === "spot" ? "/api/v3/order" : "/fapi/v1/order";

    const params: Record<string, string | number> = {
      symbol,
      side: intent.side.toUpperCase(),
      type: intent.type.toUpperCase(),
      quantity: qty,
    };

    if (intent.type === "limit") {
      params.price = limitPrice ?? 0;
      params.timeInForce = intent.timeInForce;
    }
    if (intent.reduceOnly && intent.market === "perp") {
      params.reduceOnly = "true";
    }

    const qs = binanceQuery(params, this.opts.apiSecret, Date.now());
    const r = await http(`${base}${path}?${qs}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.opts.apiKey },
    });

    if (!r.ok) {
      const msg = (r.body as { msg?: string })?.msg ?? r.raw.slice(0, 200);
      return { ok: false, reason: `${this.opts.endpoint.label}: ${msg}` };
    }

    const b = r.body as {
      orderId: number;
      status: string;
      executedQty?: string;
      cummulativeQuoteQty?: string;
      avgPrice?: string;
      fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
    };

    const filledQty = Number(b.executedQty ?? 0);
    const quote = Number(b.cummulativeQuoteQty ?? 0);
    const avg =
      filledQty > 0
        ? quote > 0
          ? quote / filledQty
          : Number(b.avgPrice ?? 0)
        : null;

    const order = this.buildOrder(intent, symbol, qty, limitPrice, {
      venueOrderId: String(b.orderId),
      status: mapBinanceStatus(b.status),
      filledQty,
      avgFillPrice: avg,
    });

    // Binance returns per-fill commission on spot; futures needs a userTrades
    // lookup. Where the fee is not in the response it is left at zero and
    // corrected by reconciliation rather than guessed at here.
    const feeUsd =
      b.fills?.reduce((a, f) => {
        const c = Number(f.commission);
        return a + (f.commissionAsset === "USDT" ? c : 0);
      }, 0) ?? 0;

    const fills: Fill[] =
      filledQty > 0 && avg
        ? [
            {
              id: `fill_${order.id}`,
              ts: Date.now(),
              venue: this.opts.endpoint.id,
              asset: intent.asset,
              market: intent.market,
              side: intent.side,
              qty: filledQty,
              price: avg,
              feeUsd,
              sleeveId: intent.sleeveId,
              strategy: intent.strategy,
              orderId: order.id,
            },
          ]
        : [];

    return { ok: true, order, fills };
  }

  /* ---------------------------------------------------------------- Bybit */

  private async submitBybit(
    intent: OrderIntent,
    symbol: string,
    qty: number,
    limitPrice?: number,
  ): Promise<SubmitResult> {
    const base = this.base(intent.market);
    const payload: Record<string, string> = {
      category: intent.market === "perp" ? "linear" : "spot",
      symbol,
      side: intent.side === "buy" ? "Buy" : "Sell",
      orderType: intent.type === "limit" ? "Limit" : "Market",
      qty: String(qty),
    };
    if (intent.type === "limit") {
      payload.price = String(limitPrice ?? 0);
      payload.timeInForce = intent.timeInForce === "IOC" ? "IOC" : "GTC";
    }
    if (intent.reduceOnly && intent.market === "perp") payload.reduceOnly = "true";

    const bodyStr = JSON.stringify(payload);
    const ts = Date.now();

    const r = await http(`${base}/v5/order/create`, {
      method: "POST",
      headers: {
        ...bybitHeaders(this.opts.apiKey, this.opts.apiSecret, bodyStr, ts),
        "Content-Type": "application/json",
      },
      body: bodyStr,
    });

    const b = r.body as { retCode?: number; retMsg?: string; result?: { orderId?: string } };

    if (!r.ok || b?.retCode !== 0) {
      return {
        ok: false,
        reason: `${this.opts.endpoint.label}: ${b?.retMsg ?? r.raw.slice(0, 200)}`,
      };
    }

    // Bybit's create response confirms acceptance, not execution. Fills arrive
    // separately, so the order is recorded as open and reconciliation fills in
    // the rest — claiming a fill here would invent one.
    const order = this.buildOrder(intent, symbol, qty, limitPrice, {
      venueOrderId: b.result?.orderId ?? null,
      status: "open",
      filledQty: 0,
      avgFillPrice: null,
    });

    return { ok: true, order, fills: [] };
  }

  /* ------------------------------------------------------------- helpers */

  private buildOrder(
    intent: OrderIntent,
    symbol: string,
    qty: number,
    limitPrice: number | undefined,
    venueState: {
      venueOrderId: string | null;
      status: Order["status"];
      filledQty: number;
      avgFillPrice: number | null;
    },
  ): Order {
    const now = Date.now();
    return {
      id: newOrderId(),
      intentId: intent.id,
      venueOrderId: venueState.venueOrderId,
      status: venueState.status,
      venue: this.opts.endpoint.id,
      asset: intent.asset,
      market: intent.market,
      side: intent.side,
      qty,
      filledQty: venueState.filledQty,
      avgFillPrice: venueState.avgFillPrice,
      type: intent.type,
      limitPrice: limitPrice ?? null,
      timeInForce: intent.timeInForce,
      sleeveId: intent.sleeveId,
      strategy: intent.strategy,
      rationale: intent.rationale,
      createdAt: now,
      updatedAt: now,
      reason: null,
      referenceMid: null,
      timings: {
        riskApprovedMs: 0,
        submittedMs: null,
        acknowledgedMs: null,
        firstFillMs: null,
        completeMs: null,
      },
    };
  }

  async cancel(orderId: string): Promise<{ ok: boolean; reason?: string }> {
    const order = this.submitted.find((o) => o.id === orderId);
    if (!order) return { ok: false, reason: "No such order in this session" };
    if (!order.venueOrderId) return { ok: false, reason: "Order has no venue id" };

    const base = this.base(order.market);
    const symbol = symbolFor(order.asset);

    if (this.opts.endpoint.family === "binance") {
      const path = order.market === "spot" ? "/api/v3/order" : "/fapi/v1/order";
      const qs = binanceQuery(
        { symbol, orderId: order.venueOrderId },
        this.opts.apiSecret,
        Date.now(),
      );
      const r = await http(`${base}${path}?${qs}`, {
        method: "DELETE",
        headers: { "X-MBX-APIKEY": this.opts.apiKey },
      });
      if (r.ok) order.status = "cancelled";
      return r.ok
        ? { ok: true }
        : { ok: false, reason: (r.body as { msg?: string })?.msg ?? `HTTP ${r.status}` };
    }

    const payload = JSON.stringify({
      category: order.market === "perp" ? "linear" : "spot",
      symbol,
      orderId: order.venueOrderId,
    });
    const r = await http(`${base}/v5/order/cancel`, {
      method: "POST",
      headers: {
        ...bybitHeaders(this.opts.apiKey, this.opts.apiSecret, payload, Date.now()),
        "Content-Type": "application/json",
      },
      body: payload,
    });
    const b = r.body as { retCode?: number; retMsg?: string };
    if (b?.retCode === 0) order.status = "cancelled";
    return b?.retCode === 0 ? { ok: true } : { ok: false, reason: b?.retMsg ?? `HTTP ${r.status}` };
  }

  /**
   * Open orders, from the VENUE rather than from our own memory.
   *
   * The exchange is always the source of truth (DESIGN.md §3). Returning our
   * local list would hide exactly the divergence this call exists to detect.
   */
  async openOrders(): Promise<Order[]> {
    const guard = this.guard();
    if (!guard.ok) return [];

    const out: Order[] = [];

    for (const market of ["spot", "perp"] as const) {
      const base = this.base(market);
      try {
        if (this.opts.endpoint.family === "binance") {
          const path = market === "spot" ? "/api/v3/openOrders" : "/fapi/v1/openOrders";
          const qs = binanceQuery({}, this.opts.apiSecret, Date.now());
          const r = await http(`${base}${path}?${qs}`, {
            headers: { "X-MBX-APIKEY": this.opts.apiKey },
          });
          if (!r.ok) continue;
          for (const o of (r.body as BinanceOpenOrder[]) ?? []) {
            out.push(this.fromBinanceOpen(o, market));
          }
        } else {
          const qs = `category=${market === "perp" ? "linear" : "spot"}&settleCoin=USDT`;
          const r = await http(`${base}/v5/order/realtime?${qs}`, {
            headers: bybitHeaders(this.opts.apiKey, this.opts.apiSecret, qs, Date.now()),
          });
          const b = r.body as { retCode?: number; result?: { list?: BybitOpenOrder[] } };
          if (b?.retCode !== 0) continue;
          for (const o of b.result?.list ?? []) {
            out.push(this.fromBybitOpen(o, market));
          }
        }
      } catch {
        // A venue that will not answer is reported as no open orders here and
        // caught by reconciliation, which is the component whose job it is.
        continue;
      }
    }

    return out;
  }

  private fromBinanceOpen(o: BinanceOpenOrder, market: "spot" | "perp"): Order {
    const now = Date.now();
    return {
      id: `venue_${o.orderId}`,
      intentId: "",
      venueOrderId: String(o.orderId),
      status: mapBinanceStatus(o.status),
      venue: this.opts.endpoint.id,
      asset: o.symbol.replace(/USDT$/, ""),
      market,
      side: o.side.toLowerCase() === "buy" ? "buy" : "sell",
      qty: Number(o.origQty),
      filledQty: Number(o.executedQty),
      avgFillPrice: null,
      type: o.type.toLowerCase() === "limit" ? "limit" : "market",
      limitPrice: Number(o.price) || null,
      timeInForce: "GTC",
      sleeveId: "unknown",
      strategy: "unknown",
      rationale: "Discovered at venue",
      createdAt: o.time ?? now,
      updatedAt: now,
      reason: null,
      referenceMid: null,
      timings: {
        riskApprovedMs: null,
        submittedMs: null,
        acknowledgedMs: null,
        firstFillMs: null,
        completeMs: null,
      },
    };
  }

  private fromBybitOpen(o: BybitOpenOrder, market: "spot" | "perp"): Order {
    const now = Date.now();
    return {
      id: `venue_${o.orderId}`,
      intentId: "",
      venueOrderId: o.orderId,
      status: "open",
      venue: this.opts.endpoint.id,
      asset: o.symbol.replace(/USDT$/, ""),
      market,
      side: o.side.toLowerCase() === "buy" ? "buy" : "sell",
      qty: Number(o.qty),
      filledQty: Number(o.cumExecQty ?? 0),
      avgFillPrice: null,
      type: o.orderType?.toLowerCase() === "limit" ? "limit" : "market",
      limitPrice: Number(o.price) || null,
      timeInForce: "GTC",
      sleeveId: "unknown",
      strategy: "unknown",
      rationale: "Discovered at venue",
      createdAt: Number(o.createdTime) || now,
      updatedAt: now,
      reason: null,
      referenceMid: null,
      timings: {
        riskApprovedMs: null,
        submittedMs: null,
        acknowledgedMs: null,
        firstFillMs: null,
        completeMs: null,
      },
    };
  }
}

type BinanceOpenOrder = {
  orderId: number;
  symbol: string;
  status: string;
  side: string;
  type: string;
  origQty: string;
  executedQty: string;
  price: string;
  time?: number;
};

type BybitOpenOrder = {
  orderId: string;
  symbol: string;
  side: string;
  orderType?: string;
  qty: string;
  cumExecQty?: string;
  price: string;
  createdTime?: string;
};

function mapBinanceStatus(status: string): Order["status"] {
  switch (status) {
    case "NEW":
      return "open";
    case "PARTIALLY_FILLED":
      return "partially_filled";
    case "FILLED":
      return "filled";
    case "CANCELED":
    case "EXPIRED":
      return "cancelled";
    case "REJECTED":
      return "rejected";
    default:
      return "pending";
  }
}
