/**
 * Tests for the FX carry opportunity scan.
 *
 * The point these pin down: a viable carry with a funded sleeve becomes a
 * take-able F1 opportunity, and the two ways it must NOT — a stale weekend fix
 * and a differential the swap markup eats — are refused with the right reason.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { defaultAllocations } from "@/lib/portfolio/sleeves";
import { resolveTier } from "@/lib/calc/tiers";
import type { FxQuote } from "@/lib/market/forex";
import { scanForex, scanForexTrend } from "./forexscan";

function quote(over: Partial<FxQuote> = {}): FxQuote {
  return {
    symbol: "USDZAR",
    base: "USD",
    quote: "ZAR",
    rate: 16.5,
    carryApr: -0.0275, // short USD / long ZAR earns the differential
    asOfDate: "2026-07-22",
    stale: false,
    ts: 1,
    ...over,
  };
}

function configWithFxCarry(navUsd = 5000) {
  const sleeves = defaultAllocations().map((a) =>
    a.sleeveId === "fx-carry" ? { ...a, allocatedUsd: 1500, enabled: true } : a,
  );
  return { ...DEFAULT_CONFIG, navUsd, sleeves };
}

const tier = resolveTier(5000, 999, "T5").current;

describe("scanForex — F1 carry", () => {
  it("produces a take-able opportunity for a viable, funded carry", () => {
    // USDJPY: a strong differential (USD 4.5% vs JPY 0.5%) and a tight spread,
    // so the carry clears the cost over the hold. USDZAR's 35bp spread eats a
    // month of carry, which is exactly why the pair choice matters.
    const usdjpy = quote({
      symbol: "USDJPY",
      base: "USD",
      quote: "JPY",
      rate: 155,
      carryApr: 0.04,
    });
    const opps = scanForex({
      config: configWithFxCarry(),
      quotes: [usdjpy],
      tier,
      dataAgeSeconds: 1,
      halted: false,
      swapMarkupApr: 0.005,
    });
    expect(opps).toHaveLength(1);
    const o = opps[0];
    expect(o.strategy).toBe("F1");
    expect(o.route).toBe("fx LONG USDJPY");
    expect(o.netBps).toBeGreaterThan(0);
    expect(o.wouldTake).toBe(true);
  });

  it("refuses a stale (weekend) fix even when the carry is good", () => {
    const opps = scanForex({
      config: configWithFxCarry(),
      quotes: [quote({ stale: true })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
      swapMarkupApr: 0.005,
    });
    expect(opps[0].wouldTake).toBe(false);
    expect(opps[0].rejectionCode).toBe("market_data_stale");
  });

  it("refuses a carry the swap markup eats", () => {
    const opps = scanForex({
      config: configWithFxCarry(),
      quotes: [quote({ carryApr: 0.01 })], // 1% differential
      tier,
      dataAgeSeconds: 1,
      halted: false,
      swapMarkupApr: 0.015, // 1.5% markup — nets negative
    });
    expect(opps[0].wouldTake).toBe(false);
  });

  it("skips a pair with no rate differential", () => {
    const opps = scanForex({
      config: configWithFxCarry(),
      quotes: [quote({ carryApr: 0 })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
    });
    expect(opps).toHaveLength(0);
  });

  it("longs the base when the base out-yields the quote", () => {
    const opps = scanForex({
      config: configWithFxCarry(),
      quotes: [quote({ symbol: "AUDUSD", base: "AUD", quote: "USD", carryApr: 0.025, rate: 0.66 })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
      swapMarkupApr: 0.005,
    });
    expect(opps[0].route).toBe("fx LONG AUDUSD");
  });
});

describe("scanForexTrend — F2", () => {
  // 80 daily closes rising ~0.1%/day with alternating wiggle, so the fast
  // average sits well above the slow one AND the return series has real
  // variance for the volatility estimate.
  const uptrend = Array.from(
    { length: 80 },
    (_, i) => 100 * (1 + 0.001 * i) + (i % 2 === 0 ? 0.15 : -0.15),
  );
  // Flat with the same wiggle: entangled averages, ranging market.
  const ranging = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 === 0 ? 0.15 : -0.15));

  function configWithFxTrend(navUsd = 5000) {
    const sleeves = defaultAllocations().map((a) =>
      a.sleeveId === "fx-trend" ? { ...a, allocatedUsd: 1500, enabled: true } : a,
    );
    return { ...DEFAULT_CONFIG, navUsd, sleeves };
  }

  it("takes an engaged trend in a funded sleeve, sized with a stop", () => {
    const opps = scanForexTrend({
      config: configWithFxTrend(),
      quotes: [quote({ symbol: "EURUSD", base: "EUR", quote: "USD", rate: 1.1 })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
      closes: { EURUSD: uptrend },
    });
    expect(opps).toHaveLength(1);
    const o = opps[0];
    expect(o.strategy).toBe("F2");
    expect(o.route).toBe("fx LONG EURUSD");
    expect(o.wouldTake).toBe(true);
    expect(o.notionalUsd).toBeGreaterThan(0);
    expect(o.trend?.stopDistanceFraction).toBeGreaterThan(0);
    // Never claims an edge — the honest numbers are the trend context.
    expect(o.netBps).toBe(0);
    expect(o.netApr).toBeNull();
  });

  it("stays flat in a range", () => {
    const opps = scanForexTrend({
      config: configWithFxTrend(),
      quotes: [quote({ symbol: "EURUSD", base: "EUR", quote: "USD", rate: 1.1 })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
      closes: { EURUSD: ranging },
    });
    expect(opps[0].wouldTake).toBe(false);
    expect(opps[0].rejectionCode).toBe("trend_not_engaged");
  });

  it("refuses when the trend sleeve is unfunded", () => {
    const opps = scanForexTrend({
      config: { ...DEFAULT_CONFIG, navUsd: 5000, sleeves: defaultAllocations() },
      quotes: [quote({ symbol: "EURUSD", base: "EUR", quote: "USD", rate: 1.1 })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
      closes: { EURUSD: uptrend },
    });
    expect(opps[0].wouldTake).toBe(false);
    expect(opps[0].rejectionCode).toBe("sleeve_disabled");
  });

  it("refuses a stale weekend fix even on a strong trend", () => {
    const opps = scanForexTrend({
      config: configWithFxTrend(),
      quotes: [quote({ symbol: "EURUSD", base: "EUR", quote: "USD", rate: 1.1, stale: true })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
      closes: { EURUSD: uptrend },
    });
    expect(opps[0].wouldTake).toBe(false);
    expect(opps[0].rejectionCode).toBe("market_data_stale");
  });
});
