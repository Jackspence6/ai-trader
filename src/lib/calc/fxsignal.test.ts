/**
 * Tests for forex signal evaluation.
 *
 * The carry test that earns its place is the swap-markup one: a raw
 * differential that looks profitable but nets to a loss once the broker takes
 * its cut. That is the exact trap the forex sleeve exists to avoid, and a signal
 * that scored the gross differential would walk straight into it.
 */

import { describe, expect, it } from "vitest";
import type { FxQuote } from "@/lib/market/forex";
import {
  annualisedVol,
  evaluateFxCarry,
  evaluateFxTrend,
  scoreFxPair,
  sma,
} from "./fxsignal";

function quote(over: Partial<FxQuote> = {}): FxQuote {
  return {
    symbol: "USDZAR",
    base: "USD",
    quote: "ZAR",
    rate: 16.5,
    carryApr: -0.0275, // USD 4.5% − ZAR 7.25%: short USD/long ZAR is the earner
    asOfDate: "2026-07-22",
    stale: false,
    ts: 1,
    ...over,
  };
}

describe("fx carry", () => {
  it("holds the higher-yielding currency", () => {
    // Negative differential (base out-yielded by quote) → short the base.
    const s = evaluateFxCarry(quote({ carryApr: -0.0275 }), { swapMarkupApr: 0.005 });
    expect(s.direction).toBe("short");
    expect(s.grossCarryApr).toBeCloseTo(0.0275, 10);
    expect(s.netCarryApr).toBeCloseTo(0.0225, 10);
    expect(s.viable).toBe(true);
  });

  it("longs the base when the base out-yields the quote", () => {
    const s = evaluateFxCarry(quote({ symbol: "AUDUSD", carryApr: 0.02 }), {
      swapMarkupApr: 0.005,
    });
    expect(s.direction).toBe("long");
  });

  it("refuses a carry the swap markup eats", () => {
    // A 1% differential against a 1.5% markup nets negative — not tradeable.
    const s = evaluateFxCarry(quote({ carryApr: 0.01 }), { swapMarkupApr: 0.015 });
    expect(s.netCarryApr).toBeLessThan(0);
    expect(s.viable).toBe(false);
    expect(s.note).toMatch(/eats/);
  });

  it("refuses a thin positive carry below the risk floor", () => {
    // Nets +0.5%, but that is not worth the volatility — below a 1% floor.
    const s = evaluateFxCarry(quote({ carryApr: 0.02 }), {
      swapMarkupApr: 0.015,
      minNetApr: 0.01,
    });
    expect(s.netCarryApr).toBeCloseTo(0.005, 10);
    expect(s.viable).toBe(false);
  });

  it("has no side when there is no differential", () => {
    expect(evaluateFxCarry(quote({ carryApr: 0 })).direction).toBe("flat");
  });
});

describe("moving averages and volatility", () => {
  it("averages the last n values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 10); // (3+4+5)/3
    expect(sma([1, 2], 3)).toBeNull();
  });

  it("annualises daily vol with a 252-day year", () => {
    // Flat series has zero volatility.
    expect(annualisedVol([1, 1, 1, 1])).toBeCloseTo(0, 10);
    // A series that moves has positive vol.
    const v = annualisedVol([1, 1.01, 0.99, 1.02, 0.98, 1.0]);
    expect(v).toBeGreaterThan(0);
  });
});

describe("fx trend", () => {
  it("goes long when the fast average leads the slow one", () => {
    // Steady uptrend: recent closes are the highest, so fast > slow.
    const closes = Array.from({ length: 70 }, (_, i) => 1 + i * 0.01);
    const s = evaluateFxTrend("EURUSD", closes, { fast: 10, slow: 30 });
    expect(s.direction).toBe("long");
    expect(s.engaged).toBe(true);
    expect(s.strengthPct).toBeGreaterThan(0);
  });

  it("stays flat in a range rather than whipsawing", () => {
    // Oscillating series with no drift: the averages sit almost on top of each
    // other, which is chop, not a trend.
    const closes = Array.from({ length: 70 }, (_, i) => 1 + (i % 2 === 0 ? 0.0005 : -0.0005));
    const s = evaluateFxTrend("EURUSD", closes, { fast: 10, slow: 30, minStrengthPct: 0.003 });
    expect(s.direction).toBe("flat");
    expect(s.engaged).toBe(false);
  });

  it("reports it needs more data when history is short", () => {
    const s = evaluateFxTrend("EURUSD", [1, 1.01, 1.02], { fast: 10, slow: 30 });
    expect(s.direction).toBe("flat");
    expect(s.note).toMatch(/closes/);
  });
});

describe("scoreFxPair", () => {
  it("scores both strategies and preserves quote provenance", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 16 + i * 0.02);
    const s = scoreFxPair(quote(), closes, { fast: 10, slow: 30, swapMarkupApr: 0.005 });
    expect(s.symbol).toBe("USDZAR");
    expect(s.stale).toBe(false);
    expect(s.carry.direction).toBe("short");
    expect(s.trend.direction).toBe("long");
  });
});
