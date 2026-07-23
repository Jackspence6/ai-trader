/**
 * Tests for the opportunity scanner's horizon handling.
 *
 * The property under test is the one that cost real money: each strategy must
 * be scored over the horizon its signal actually survives. Cross-venue spreads
 * mean-revert within a day, so scoring them over the 21-day carry hold booked
 * ~18× the income they could ever earn and made structurally losing trades
 * look like 30bp edges.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { defaultAllocations } from "@/lib/portfolio/sleeves";
import type { MarketSnapshot, Quote } from "@/lib/market/types";
import { L2_SPREAD_HOLD_DAYS, scan } from "./scanner";

function perp(venue: string, fundingApr: number, over: Partial<Quote> = {}): Quote {
  return {
    venue,
    asset: "BTC",
    kind: "perp",
    last: 100_000,
    bid: 99_995,
    ask: 100_005,
    spreadBps: 1,
    topOfBookUsd: 5_000_000,
    high24h: 0,
    low24h: 0,
    change24hPct: 0,
    volume24hUsd: 0,
    fundingRate: fundingApr / ((24 * 365) / 8),
    fundingIntervalHours: 8,
    fundingApr,
    ts: Date.now(),
    ...over,
  };
}

function snapshotWith(quotes: Quote[]): MarketSnapshot {
  return { asOf: Date.now(), quotes, errors: [] };
}

function config() {
  const sleeves = defaultAllocations().map((a) =>
    a.sleeveId === "core" ? { ...a, allocatedUsd: 6_000, enabled: true } : a,
  );
  return { ...DEFAULT_CONFIG, navUsd: 10_000, sleeves };
}

const l2Of = (quotes: Quote[]) =>
  scan({ config: config(), snapshot: snapshotWith(quotes), halted: false }).find(
    (o) => o.strategy === "L2",
  );

describe("L2 spread horizon", () => {
  it("is scored over its own short horizon, not the carry hold", () => {
    expect(L2_SPREAD_HOLD_DAYS).toBeLessThan(DEFAULT_CONFIG.expectedHoldDays);
  });

  it("REGRESSION: a typical live spread no longer books a fake edge", () => {
    // ~11% APR spread — the shape the live book kept entering and losing on.
    // Over 21 days it scored ~30bp net; over the horizon it actually persists
    // it cannot cover its own round trip, so it must be rejected.
    const o = l2Of([perp("Binance", 0.12), perp("Bybit", 0.01)]);
    expect(o).toBeDefined();
    expect(o!.netBps).toBeLessThan(0);
    expect(o!.wouldTake).toBe(false);
  });

  it("still reports the opportunity rather than hiding it", () => {
    // Rejected, not invisible: the Opportunities feed is how we learn the
    // strategy is untradeable, so the row and its reason must survive.
    const o = l2Of([perp("Binance", 0.12), perp("Bybit", 0.01)]);
    expect(o!.strategy).toBe("L2");
    expect(o!.rejectionCode).not.toBeNull();
  });

  it("would still take a spread genuinely wide enough to pay for itself", () => {
    // The gate is honest, not closed: an enormous spread that clears its cost
    // within two days is still tradeable if the market ever offers one.
    const o = l2Of([perp("Binance", 3.0), perp("Bybit", 0.01)]);
    expect(o!.netBps).toBeGreaterThan(0);
  });

  it("scores gross income on the short horizon", () => {
    // grossBps = spreadApr × holdDays / 365. A 3.65% spread over 2 days is
    // 0.02% = 2bp, hand-checkable.
    const o = l2Of([perp("Binance", 0.0365), perp("Bybit", 0)]);
    expect(o!.grossBps).toBeCloseTo(((0.0365 * L2_SPREAD_HOLD_DAYS) / 365) * 10_000, 4);
  });
});
