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
import { scanForex } from "./forexscan";

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
