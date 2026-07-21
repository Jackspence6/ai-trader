/**
 * Order management types and the venue interface.
 *
 * DESIGN.md principle 1: one strategy codebase across backtest, paper and live,
 * where the only thing that changes between modes is which venue implementation
 * sits behind this interface. That is the whole reason `Venue` is defined here
 * as a narrow contract rather than each mode growing its own order path — if
 * paper and live can diverge, they will, and you find out with real money.
 *
 * Note what the interface does NOT have: no `flatten()`, no `closeAll()`, no
 * convenience that hides how many orders were sent. Every position change is an
 * explicit order with an explicit size, because the audit trail is only as good
 * as the granularity of the thing being audited.
 */

import type { Fill, Side } from "@/lib/portfolio/positions";

export type OrderType = "market" | "limit";

export type TimeInForce = "GTC" | "IOC" | "FOK";

/**
 * What a strategy asks for.
 *
 * Intents are proposals. They carry no order id and have no venue state — they
 * do not become orders until the risk gate approves them.
 */
export type OrderIntent = {
  id: string;
  ts: number;
  venue: string;
  asset: string;
  market: "spot" | "perp";
  side: Side;
  /** Positive quantity in base units. */
  qty: number;
  type: OrderType;
  /** Required for limit orders, ignored for market. */
  limitPrice?: number;
  timeInForce: TimeInForce;
  /** Which sleeve funds this, and whose limits apply. */
  sleeveId: string;
  strategy: string;
  /** Why this intent exists — carried into the audit trail. */
  rationale: string;
  /** Set when the intent should only reduce an existing position. */
  reduceOnly?: boolean;
};

export type OrderStatus =
  | "pending"
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected";

export type Order = {
  id: string;
  intentId: string;
  venueOrderId: string | null;
  status: OrderStatus;
  venue: string;
  asset: string;
  market: "spot" | "perp";
  side: Side;
  qty: number;
  filledQty: number;
  avgFillPrice: number | null;
  type: OrderType;
  limitPrice: number | null;
  timeInForce: TimeInForce;
  sleeveId: string;
  strategy: string;
  rationale: string;
  createdAt: number;
  updatedAt: number;
  /** Set when rejected or cancelled. */
  reason: string | null;
  /**
   * The mid price this order was priced against.
   *
   * Slippage must be measured against the benchmark the fill was actually
   * priced from, not against last-traded price — those differ by up to a
   * half-spread, and attributing that gap to slippage makes the cost model
   * look wrong when it is the measurement that is.
   */
  referenceMid: number | null;
  /**
   * Latency breakdown, in ms from intent creation. DESIGN.md §8.5 wants this
   * per order — it is how execution quality gets diagnosed, and it cannot be
   * reconstructed after the fact.
   */
  timings: {
    riskApprovedMs: number | null;
    submittedMs: number | null;
    acknowledgedMs: number | null;
    firstFillMs: number | null;
    completeMs: number | null;
  };
};

export type SubmitResult =
  | { ok: true; order: Order; fills: Fill[] }
  | { ok: false; reason: string };

/**
 * The venue contract.
 *
 * Implemented by `SimulatedVenue` today and by live venue adapters later. The
 * live implementations are deliberately not written yet: ROADMAP puts the kill
 * switch (done) and this interface ahead of any code that can actually reach an
 * exchange with an order.
 */
export interface Venue {
  readonly id: string;
  /** True when orders reach a real exchange. Rendered prominently in the UI. */
  readonly isLive: boolean;

  submit(intent: OrderIntent): Promise<SubmitResult>;
  cancel(orderId: string): Promise<{ ok: boolean; reason?: string }>;
  openOrders(): Promise<Order[]>;
}

/** Market state a simulated venue needs to price a fill. */
export type BookSnapshot = {
  asset: string;
  venue: string;
  market: "spot" | "perp";
  bid: number;
  ask: number;
  spreadBps: number;
  /** Visible size at the touch, in USD. */
  topOfBookUsd: number;
};

export function newOrderId(): string {
  // Monotonic-ish and readable in a log. Not security-sensitive.
  return `ord_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function newIntentId(): string {
  return `int_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
