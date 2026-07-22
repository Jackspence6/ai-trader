/**
 * Tests for FX carry accrual.
 *
 * The sign is the thing that must be right: holding the higher-yielding
 * currency earns, holding the lower-yielding one pays, and the swap markup is a
 * cost either way. A sign error here would manufacture profit out of a losing
 * position, which is exactly the failure carry accrual must never have.
 */

import { describe, expect, it } from "vitest";
import type { FxQuote } from "@/lib/market/forex";
import { accrueFxCarry } from "./fxcarry";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function quote(over: Partial<FxQuote> = {}): FxQuote {
  return {
    symbol: "USDZAR",
    base: "USD",
    quote: "ZAR",
    rate: 16.5,
    carryApr: -0.0275, // USD 4.5% − ZAR 7.25%
    asOfDate: "2026-07-22",
    stale: false,
    ts: 1,
    ...over,
  };
}

function pos(qty: number) {
  return { asset: "USDZAR", qty, sleeveId: "fx-carry", venue: "fx" };
}

describe("accrueFxCarry", () => {
  it("earns the differential when short the base (long the high-yielder)", () => {
    // Short USDZAR = long ZAR (7.25%) vs short USD (4.5%): earns +2.75% before
    // the swap. Over a full year on a 1650-notional short (qty −100 × 16.5),
    // net of a 0.5% swap: (0.0275 − 0.005) × 1650 = 37.125.
    const [p] = accrueFxCarry([pos(-100)], [quote()], YEAR_MS, 1000, {
      swapMarkupApr: 0.005,
    });
    expect(p.amountUsd).toBeCloseTo(0.0225 * 1650, 6);
    expect(p.venue).toBe("fx");
    expect(p.sleeveId).toBe("fx-carry");
  });

  it("pays the differential when long the base (long the low-yielder)", () => {
    // Long USDZAR = long USD (4.5%) vs short ZAR (7.25%): −2.75% before swap,
    // and the swap makes it worse. Must be negative.
    const [p] = accrueFxCarry([pos(100)], [quote()], YEAR_MS, 1000, {
      swapMarkupApr: 0.005,
    });
    expect(p.amountUsd).toBeLessThan(0);
    expect(p.amountUsd).toBeCloseTo((-0.0275 - 0.005) * 1650, 6);
  });

  it("scales with elapsed time", () => {
    const full = accrueFxCarry([pos(-100)], [quote()], YEAR_MS, 1000, { swapMarkupApr: 0.005 });
    const half = accrueFxCarry([pos(-100)], [quote()], YEAR_MS / 2, 1000, {
      swapMarkupApr: 0.005,
    });
    expect(half[0].amountUsd).toBeCloseTo(full[0].amountUsd / 2, 9);
  });

  it("accrues nothing over zero elapsed", () => {
    expect(accrueFxCarry([pos(-100)], [quote()], 0, 1000)).toHaveLength(0);
  });

  it("ignores non-FX positions and unpriced pairs", () => {
    const crypto = { asset: "BTC", qty: 1, sleeveId: "core", venue: "binance" };
    const noQuote = pos(-100);
    const out = accrueFxCarry([crypto, noQuote], [], YEAR_MS, 1000);
    expect(out).toHaveLength(0);
  });
});
