/**
 * Tests for the forex feed.
 *
 * The one that earns its place is the quote-convention test. Getting USDJPY
 * inverted — 0.006 instead of 150 — produced a plausible-looking number that
 * was wrong by four orders of magnitude, and every downstream volatility and
 * carry figure inherited it. It is exactly the kind of bug that does not throw.
 */

import { describe, expect, it } from "vitest";
import { carryApr, FX_PAIRS, POLICY_RATES } from "./forex";

describe("fx carry", () => {
  it("is the base rate minus the quote rate", () => {
    // Hold the higher-yielding currency, earn the difference.
    expect(carryApr("USD", "JPY")).toBeCloseTo(POLICY_RATES.USD - POLICY_RATES.JPY, 10);
    expect(carryApr("EUR", "USD")).toBeCloseTo(POLICY_RATES.EUR - POLICY_RATES.USD, 10);
  });

  it("is negative on the low-yield side of a pair", () => {
    // EUR (2.5%) vs USD (4.5%): holding EUR against USD pays, it does not earn.
    expect(carryApr("EUR", "USD")).toBeLessThan(0);
    // ...and the reverse is symmetric.
    expect(carryApr("USD", "EUR")).toBeCloseTo(-carryApr("EUR", "USD"), 10);
  });

  it("returns zero for a currency with no reference rate", () => {
    expect(carryApr("XXX", "USD")).toBe(0);
  });
});

describe("fx pairs", () => {
  it("names every currency it references in POLICY_RATES", () => {
    // A pair whose currency has no policy rate silently carries zero, which
    // would hide it from the carry scanner rather than erroring.
    for (const p of FX_PAIRS) {
      expect(POLICY_RATES[p.base], `${p.base} rate missing`).toBeDefined();
      expect(POLICY_RATES[p.quote], `${p.quote} rate missing`).toBeDefined();
    }
  });

  it("follows majors, quoted by convention", () => {
    // EUR, GBP, AUD are USD-quoted; JPY, CAD, CHF, ZAR are USD-based. This is
    // not cosmetic — it decides which side of the Frankfurter rate is the
    // pair price, and getting it wrong inverts the quote.
    const bySym = new Map(FX_PAIRS.map((p) => [p.symbol, p]));
    expect(bySym.get("EURUSD")!.quote).toBe("USD");
    expect(bySym.get("USDJPY")!.base).toBe("USD");
    expect(bySym.get("USDZAR")!.base).toBe("USD");
  });
});
