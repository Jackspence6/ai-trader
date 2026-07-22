/**
 * Tests for cash-and-carry basis evaluation.
 *
 * The number that must be right is the annualisation: a basis is meaningless
 * without its horizon, and a raw percentage compared across different expiries
 * is the classic way to make a 90-day trade look like a 3-day one. The direction
 * (contango → buy spot/short future) is the other thing a sign error would
 * silently invert.
 */

import { describe, expect, it } from "vitest";
import type { CostBreakdown } from "./costs";
import { evaluateBasis, parseDeliveryExpiry, MS_PER_DAY } from "./basis";

const NOW = 1_700_000_000_000;
const freeCost: CostBreakdown = { feeBps: 0, spreadBps: 0, slippageBps: 0, totalBps: 0, totalUsd: 0 };

function cost(totalUsd: number): CostBreakdown {
  return { feeBps: 0, spreadBps: 0, slippageBps: 0, totalBps: 0, totalUsd };
}

describe("evaluateBasis", () => {
  it("annualises a contango basis to expiry", () => {
    // 2% over 90 days ≈ 8.1% a year; contango → buy spot, short future.
    const r = evaluateBasis({
      spot: 100,
      future: 102,
      expiryMs: NOW + 90 * MS_PER_DAY,
      now: NOW,
      cost: freeCost,
      legNotionalUsd: 1000,
    });
    expect(r.basisPct).toBeCloseTo(0.02, 10);
    expect(r.daysToExpiry).toBeCloseTo(90, 6);
    expect(r.annualisedBasisApr).toBeCloseTo(0.02 * (365 / 90), 6);
    expect(r.direction).toBe("cash-and-carry");
    expect(r.viable).toBe(true);
  });

  it("flags backwardation as the reverse trade", () => {
    const r = evaluateBasis({
      spot: 100,
      future: 98,
      expiryMs: NOW + 30 * MS_PER_DAY,
      now: NOW,
      cost: freeCost,
      legNotionalUsd: 1000,
    });
    expect(r.basisPct).toBeCloseTo(-0.02, 10);
    expect(r.direction).toBe("reverse-carry");
    expect(r.annualisedBasisApr).toBeLessThan(0);
  });

  it("nets the round-trip cost out of the edge", () => {
    // 1% basis on $1000 = $10 gross; a $6 round trip leaves $4 net.
    const r = evaluateBasis({
      spot: 100,
      future: 101,
      expiryMs: NOW + 30 * MS_PER_DAY,
      now: NOW,
      cost: cost(6),
      legNotionalUsd: 1000,
    });
    expect(r.expectedProfitUsd).toBeCloseTo(4, 6);
    expect(r.viable).toBe(true);
  });

  it("refuses a basis the cost eats", () => {
    // 0.3% basis on $1000 = $3 gross against a $6 round trip → net negative.
    const r = evaluateBasis({
      spot: 100,
      future: 100.3,
      expiryMs: NOW + 20 * MS_PER_DAY,
      now: NOW,
      cost: cost(6),
      legNotionalUsd: 1000,
    });
    expect(r.expectedProfitUsd).toBeLessThan(0);
    expect(r.viable).toBe(false);
  });

  it("has no trade at or past expiry", () => {
    const r = evaluateBasis({
      spot: 100,
      future: 102,
      expiryMs: NOW,
      now: NOW,
      cost: freeCost,
      legNotionalUsd: 1000,
    });
    expect(r.direction).toBe("none");
    expect(r.viable).toBe(false);
  });
});

describe("parseDeliveryExpiry", () => {
  it("reads the settlement date from a Binance quarterly symbol", () => {
    expect(parseDeliveryExpiry("BTCUSDT_250926")).toBe(Date.parse("2025-09-26T08:00:00Z"));
    expect(parseDeliveryExpiry("ETHUSDT_261225")).toBe(Date.parse("2026-12-25T08:00:00Z"));
  });
  it("returns null for a perpetual", () => {
    expect(parseDeliveryExpiry("BTCUSDT")).toBeNull();
  });
});
