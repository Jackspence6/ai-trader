/**
 * Tests for the FX backtests.
 *
 * The properties that matter: the trend replay follows the LIVE signal (it
 * must trade a clean trend and stay flat in a range), carry is signed
 * correctly in both directions (the mistake that flatters shorts in
 * high-carry pairs), and the F1 decomposition separates the deterministic
 * carry from the price path.
 */

import { describe, expect, it } from "vitest";
import { backtestFxCarry, backtestFxTrend, type FxDaily } from "./fx";

const DAY = 86_400_000;

function series(rates: number[]): FxDaily[] {
  return rates.map((rate, i) => ({ t: i * DAY, rate }));
}

/** A clean rising series with a small deterministic wiggle for vol. */
function rising(n: number, drift = 0.002): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(100 * (1 + drift * i) + (i % 2 === 0 ? 0.05 : -0.05));
  }
  return out;
}

const TREND_PARAMS = {
  fast: 20,
  slow: 60,
  minStrengthPct: 0.003,
  roundTripCostFraction: 0.0005,
  differentialApr: 0,
  swapMarkupApr: 0,
};

describe("backtestFxTrend", () => {
  it("rides a clean uptrend and banks the price move", () => {
    const { bt, extra } = backtestFxTrend(series(rising(200)), TREND_PARAMS);
    expect(bt.intervalsHeld).toBeGreaterThan(80);
    expect(extra.priceReturn).toBeGreaterThan(0.05);
    expect(bt.equity[bt.equity.length - 1].cumReturn).toBeGreaterThan(0);
  });

  it("stays flat in a range — no trades, no costs", () => {
    const flat = Array.from({ length: 200 }, (_, i) => 100 + (i % 2 === 0 ? 0.05 : -0.05));
    const { bt } = backtestFxTrend(series(flat), TREND_PARAMS);
    expect(bt.trades).toHaveLength(0);
    expect(bt.intervalsHeld).toBe(0);
    expect(bt.equity[bt.equity.length - 1].cumReturn).toBe(0);
  });

  it("charges the differential AGAINST a short in a high-carry pair", () => {
    // Falling series → the signal goes short. With base−quote = +5%, a short
    // pays the differential; with swap on top, carryReturn must be negative.
    const falling = rising(200).map((_, i) => 120 * (1 - 0.002 * i) + (i % 2 === 0 ? 0.05 : -0.05));
    const { extra } = backtestFxTrend(series(falling), {
      ...TREND_PARAMS,
      differentialApr: 0.05,
      swapMarkupApr: 0.015,
    });
    expect(extra.carryReturn).toBeLessThan(0);
    // But the price leg of a genuine downtrend is still profitable.
    expect(extra.priceReturn).toBeGreaterThan(0);
  });

  it("cuts a reversing trend on the volatility stop or flip", () => {
    const upThenDown = [
      ...rising(120),
      ...rising(120).map((v, i) => rising(120)[119] - 0.4 * i),
    ];
    const { bt, extra } = backtestFxTrend(series(upThenDown), TREND_PARAMS);
    expect(bt.trades.length).toBeGreaterThan(0);
    expect(extra.exits.flip + extra.exits.stop).toBe(bt.trades.length);
  });
});

describe("backtestFxCarry", () => {
  const CARRY_PARAMS = {
    differentialApr: 0.04,
    swapMarkupApr: 0.015,
    minNetApr: 0.01,
    roundTripCostFraction: 0.0005,
    stopLossPct: 0.12,
  };

  it("earns the net carry deterministically on a flat price path", () => {
    const flat = Array.from({ length: 366 }, () => 100);
    const { bt, extra } = backtestFxCarry(series(flat), CARRY_PARAMS);
    // 365 accrual days of (4% − 1.5%)/365 ≈ 2.5%, minus one round trip.
    expect(extra.carryReturn).toBeCloseTo(0.025, 3);
    expect(extra.priceReturn).toBeCloseTo(0, 10);
    expect(bt.equity[bt.equity.length - 1].cumReturn).toBeCloseTo(0.025 - 0.0005, 3);
  });

  it("holds the SHORT side when the differential is negative", () => {
    // base−quote = −4%: shorting the base earns it. On a falling price path
    // the short also gains on price, so both components are positive.
    const falling = Array.from({ length: 200 }, (_, i) => 100 * (1 - 0.001 * i));
    const { extra } = backtestFxCarry(series(falling), {
      ...CARRY_PARAMS,
      differentialApr: -0.04,
    });
    expect(extra.direction).toBe(-1);
    expect(extra.carryReturn).toBeGreaterThan(0);
    expect(extra.priceReturn).toBeGreaterThan(0);
  });

  it("refuses a pair whose net carry is under the floor", () => {
    const { bt, extra } = backtestFxCarry(series(rising(100)), {
      ...CARRY_PARAMS,
      differentialApr: 0.02, // net 0.5% < 1% floor
    });
    expect(extra.direction).toBe(0);
    expect(bt.trades).toHaveLength(0);
    expect(bt.intervalsHeld).toBe(0);
  });

  it("stops out on a crash and re-enters, paying a fresh round trip", () => {
    // Long carry into a 30% crash: the 12% backstop must fire at least once,
    // and the replay must re-enter while the carry is still viable.
    const crash = [
      ...Array.from({ length: 50 }, () => 100),
      ...Array.from({ length: 60 }, (_, i) => 100 * (1 - 0.005 * (i + 1))),
      ...Array.from({ length: 50 }, () => 70),
    ];
    const { bt, extra } = backtestFxCarry(series(crash), CARRY_PARAMS);
    expect(extra.stops).toBeGreaterThan(0);
    expect(bt.trades.every((t) => !t.win)).toBe(true);
    // Still in a position at the end (re-entered after the last stop).
    expect(bt.intervalsHeld).toBeGreaterThan(bt.trades.reduce((a, t) => a + t.intervals, 0));
  });
});
