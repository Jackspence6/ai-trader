/**
 * Simulated venue — paper trading.
 *
 * The point of this file is to be *pessimistic*. DESIGN.md §9 is blunt about
 * it: a backtester that lies is worse than none, because it manufactures
 * confidence. The same applies to paper trading, and the temptation is
 * identical — a simulator that fills at mid with no costs produces beautiful
 * equity curves and teaches you nothing.
 *
 * So every fill here pays:
 *   - the venue's real taker fee at our tier
 *   - the full half-spread, crossing from mid to the touch
 *   - square-root market impact from the SAME cost model the scanner uses
 *
 * That last point matters more than it looks. If the simulator used a
 * different cost model from the scanner, predicted edge and realised edge would
 * diverge for a reason that has nothing to do with the market — and the
 * predicted-vs-realised diagnostic, which is the whole reason to paper trade,
 * would be measuring our own inconsistency.
 *
 * Deliberately NOT modelled, and the honest reasons:
 *   - Queue position for limit orders. Doing it properly needs the recorded L2
 *     book, which is what the backtester (ROADMAP B1) will replay. Until then
 *     limit orders here are treated as marketable, which is pessimistic for
 *     passive strategies and therefore the safe direction to be wrong in.
 *   - Partial fills. Every accepted order fills completely.
 *   - Rejections from venue-side risk checks.
 */

import {
  DEFAULT_VENUE_FEES,
  legFeeBps,
  slippageBps,
  BPS,
  type VenueFees,
} from "@/lib/calc/costs";
import type { Fill } from "@/lib/portfolio/positions";
import {
  newOrderId,
  type BookSnapshot,
  type Order,
  type OrderIntent,
  type SubmitResult,
  type Venue,
} from "./types";

export type SimulatedVenueOptions = {
  /**
   * Simulated round-trip latency in ms, applied to the timing breakdown.
   * Does not delay the call; it records what a real venue would have cost us.
   */
  latencyMs?: number;
  feeTable?: Record<string, VenueFees>;
};

export class SimulatedVenue implements Venue {
  readonly id = "simulated";
  readonly isLive = false;

  private books = new Map<string, BookSnapshot>();
  private orders: Order[] = [];
  private latencyMs: number;
  private feeTable: Record<string, VenueFees>;

  constructor(opts: SimulatedVenueOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 45;
    this.feeTable = opts.feeTable ?? DEFAULT_VENUE_FEES;
  }

  /** Feed live or recorded market state in. */
  setBooks(books: BookSnapshot[]): void {
    for (const b of books) {
      this.books.set(`${b.venue}:${b.asset}:${b.market}`, b);
    }
  }

  private book(intent: OrderIntent): BookSnapshot | undefined {
    return this.books.get(`${intent.venue}:${intent.asset}:${intent.market}`);
  }

  async submit(intent: OrderIntent): Promise<SubmitResult> {
    const book = this.book(intent);

    if (!book) {
      // No market data means no honest fill price. Refusing is correct — a
      // simulator that invents a price when it does not know one is precisely
      // the lie this file exists to avoid.
      return {
        ok: false,
        reason: `No market data for ${intent.venue} ${intent.asset} ${intent.market}`,
      };
    }

    if (intent.qty <= 0) {
      return { ok: false, reason: "Quantity must be positive" };
    }

    const mid = (book.bid + book.ask) / 2;
    if (!(mid > 0)) {
      return { ok: false, reason: "Book has no usable mid price" };
    }

    const notionalUsd = intent.qty * mid;
    const fees = this.feeTable[intent.venue.toLowerCase()];

    // Unknown venue falls back to the worst schedule we know, matching the
    // scanner's cost model rather than quietly costing nothing.
    const resolvedFees =
      fees ??
      Object.values(this.feeTable).reduce((worst, v) =>
        v.spot.takerBps > worst.spot.takerBps ? v : worst,
      );

    if (notionalUsd < resolvedFees.minNotionalUsd) {
      return {
        ok: false,
        reason: `Notional $${notionalUsd.toFixed(2)} below venue minimum $${resolvedFees.minNotionalUsd}`,
      };
    }

    // --- price the fill ---------------------------------------------------
    //
    // Cross the spread, then pay impact on top. Buys fill worse (higher),
    // sells fill worse (lower) — the sign is the easiest thing to get wrong
    // here, and getting it wrong makes every simulated trade profitable.
    const impactBps = slippageBps(notionalUsd, book.topOfBookUsd, book.spreadBps);
    const adverseBps = book.spreadBps / 2 + impactBps;
    const direction = intent.side === "buy" ? 1 : -1;
    const fillPrice = mid * (1 + (direction * adverseBps) / BPS);

    const feeBps = legFeeBps(resolvedFees, intent.market, "taker");
    const feeUsd = (feeBps / BPS) * intent.qty * fillPrice;

    const now = Date.now();
    const order: Order = {
      id: newOrderId(),
      intentId: intent.id,
      venueOrderId: `sim_${newOrderId()}`,
      status: "filled",
      venue: intent.venue,
      asset: intent.asset,
      market: intent.market,
      side: intent.side,
      qty: intent.qty,
      filledQty: intent.qty,
      avgFillPrice: fillPrice,
      type: intent.type,
      limitPrice: intent.limitPrice ?? null,
      timeInForce: intent.timeInForce,
      sleeveId: intent.sleeveId,
      strategy: intent.strategy,
      rationale: intent.rationale,
      createdAt: now,
      updatedAt: now,
      reason: null,
      referenceMid: mid,
      timings: {
        riskApprovedMs: 0,
        submittedMs: 1,
        acknowledgedMs: this.latencyMs,
        firstFillMs: this.latencyMs,
        completeMs: this.latencyMs,
      },
    };

    const fill: Fill = {
      id: `fill_${order.id}`,
      ts: now,
      venue: intent.venue,
      asset: intent.asset,
      market: intent.market,
      side: intent.side,
      qty: intent.qty,
      price: fillPrice,
      feeUsd,
      sleeveId: intent.sleeveId,
      strategy: intent.strategy,
      orderId: order.id,
    };

    this.orders.push(order);
    return { ok: true, order, fills: [fill] };
  }

  async cancel(orderId: string): Promise<{ ok: boolean; reason?: string }> {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) return { ok: false, reason: "No such order" };
    if (order.status === "filled") {
      return { ok: false, reason: "Order already filled" };
    }
    order.status = "cancelled";
    order.updatedAt = Date.now();
    return { ok: true };
  }

  async openOrders(): Promise<Order[]> {
    // Everything fills immediately in this model, so there is never anything
    // resting. Stated rather than left to be inferred from an empty array.
    return this.orders.filter(
      (o) => o.status === "open" || o.status === "partially_filled",
    );
  }

  /** All orders this venue has seen, for the audit trail. */
  allOrders(): Order[] {
    return [...this.orders];
  }
}

/** Build book snapshots from a live market snapshot. */
export function booksFromQuotes(
  quotes: {
    venue: string;
    asset: string;
    kind: "spot" | "perp";
    bid: number;
    ask: number;
    spreadBps: number;
    topOfBookUsd: number;
  }[],
): BookSnapshot[] {
  return quotes
    .filter((q) => q.bid > 0 && q.ask > 0)
    .map((q) => ({
      asset: q.asset,
      venue: q.venue,
      market: q.kind,
      bid: q.bid,
      ask: q.ask,
      spreadBps: q.spreadBps,
      topOfBookUsd: q.topOfBookUsd,
    }));
}
