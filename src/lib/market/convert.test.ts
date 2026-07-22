/**
 * Tests for the resilient currency converter.
 *
 * The guarantee under test is the one the operator relies on: a conversion is
 * never unavailable. The pure helpers here are what carry that guarantee — the
 * reciprocal maths, the seed fallback, and the FxRates adaptation — so they are
 * pinned with hand-computable numbers.
 */

import { describe, expect, it } from "vitest";
import {
  convert,
  inDisplayCurrencies,
  toFxRates,
  usdPerUnit,
  type RateTable,
} from "./convert";

const table: RateTable = {
  // 1 USD = ~16.667 ZAR, 1 EUR = 1.08 USD.
  usdPer: { USD: 1, ZAR: 0.06, EUR: 1.08, GBP: 1.27 },
  source: "live",
  asOf: "2026-07-22",
  ts: 1,
};

describe("currency converter", () => {
  it("converts USD to ZAR and back", () => {
    expect(convert(table, 300, "USD", "ZAR")).toBeCloseTo(5000, 6);
    expect(convert(table, 5000, "ZAR", "USD")).toBeCloseTo(300, 6);
  });

  it("converts between two non-USD currencies through USD", () => {
    // 108 EUR = $116.64 = R1944.
    expect(convert(table, 108, "EUR", "ZAR")).toBeCloseTo(1944, 4);
  });

  it("falls back to the seed rate for an unknown table entry", () => {
    const sparse: RateTable = { ...table, usdPer: { USD: 1 } };
    // ZAR missing from the table → seed (~0.06) is used, never zero.
    expect(usdPerUnit(sparse, "ZAR")).toBeGreaterThan(0);
  });

  it("renders a USD amount in every display currency at once", () => {
    const m = inDisplayCurrencies(table, 300);
    expect(m.values.USD).toBe(300);
    expect(m.values.ZAR).toBeCloseTo(5000, 6);
    expect(m.source).toBe("live");
  });

  it("adapts to the FxRates shape as units-per-USD (the reciprocal)", () => {
    const fx = toFxRates(table);
    expect(fx.rates.USD).toBe(1);
    expect(fx.rates.ZAR).toBeCloseTo(1 / 0.06, 6); // ~16.667 ZAR per USD
    expect(fx.rates.EUR).toBeCloseTo(1 / 1.08, 6);
    // Never flagged degraded — a cached or seed rate is still a usable rate.
    expect(fx.degraded).toBe(false);
    expect(fx.source).toBe("live");
  });
});
