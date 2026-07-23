/**
 * Tests for the cross-venue spread backtest.
 *
 * The properties that matter: alignment survives the venues' timestamp
 * jitter, direction is chosen correctly at entry (a negative spread is just
 * as tradeable reversed), and the exit deadband actually reduces churn — the
 * behaviour the whole module exists to measure.
 */

import { describe, expect, it } from "vitest";
import {
  alignSeries,
  backtestSpread,
  sweepExitDeadband,
  type SpreadBacktestParams,
  type SpreadPoint,
} from "./spread";

const H8 = 8 * 3600_000;
const INTERVALS_PER_YEAR = (24 * 365) / 8;

/** Per-interval rate implied by an annualised figure. */
const rateOf = (apr: number) => apr / INTERVALS_PER_YEAR;

function series(aprs: number[], start = 0): SpreadPoint[] {
  return aprs.map((apr, i) => ({
    t: start + i * H8,
    rateA: rateOf(apr),
    rateB: 0,
    spreadApr: apr,
  }));
}

const PARAMS: Omit<SpreadBacktestParams, "exitSpreadApr"> = {
  minSpreadApr: 0.05,
  minNetEdgeBps: 10,
  roundTripCostFraction: 0.002, // 20bp
  expectedHoldDays: 21,
};

describe("alignSeries", () => {
  it("survives Binance's millisecond timestamp jitter", () => {
    // Binance stamps 16:00:00.002 where Bybit stamps 16:00:00.000. An exact
    // join drops the row; bucketing to the interval keeps it.
    const a = [
      { t: 0, rate: 0.001, apr: 1 },
      { t: H8 + 2, rate: 0.002, apr: 2 },
      { t: 2 * H8 + 1, rate: 0.003, apr: 3 },
    ];
    const b = [
      { t: 0, rate: 0.0005, apr: 0.5 },
      { t: H8, rate: 0.0005, apr: 0.5 },
      { t: 2 * H8, rate: 0.0005, apr: 0.5 },
    ];
    expect(alignSeries(a, b)).toHaveLength(3);
  });

  it("drops intervals only one venue covers", () => {
    const a = [
      { t: 0, rate: 0.001, apr: 1 },
      { t: H8, rate: 0.001, apr: 1 },
    ];
    const b = [{ t: 0, rate: 0, apr: 0 }];
    expect(alignSeries(a, b)).toHaveLength(1);
  });

  it("computes the annualised spread as A minus B", () => {
    const a = [{ t: 0, rate: rateOf(0.2), apr: 0.2 }];
    const b = [{ t: 0, rate: rateOf(0.05), apr: 0.05 }];
    expect(alignSeries(a, b)[0].spreadApr).toBeCloseTo(0.15, 6);
  });
});

describe("backtestSpread", () => {
  it("enters a rich spread and earns the differential while held", () => {
    const bt = backtestSpread(series(new Array(60).fill(0.3)), {
      ...PARAMS,
      exitSpreadApr: 0,
    });
    expect(bt.intervalsHeld).toBeGreaterThan(50);
    // Held throughout a persistently rich spread → cumulative return positive
    // after paying the single round trip up front.
    expect(bt.equity[bt.equity.length - 1].cumReturn).toBeGreaterThan(0);
  });

  it("trades a deeply NEGATIVE spread by reversing the legs", () => {
    // Same magnitude, opposite sign: the live scanner would short the other
    // venue, so the backtest must earn the same amount.
    const pos = backtestSpread(series(new Array(60).fill(0.3)), { ...PARAMS, exitSpreadApr: 0 });
    const neg = backtestSpread(series(new Array(60).fill(-0.3)), { ...PARAMS, exitSpreadApr: 0 });
    expect(neg.equity[neg.equity.length - 1].cumReturn).toBeCloseTo(
      pos.equity[pos.equity.length - 1].cumReturn,
      6,
    );
  });

  it("refuses a spread too thin to clear its costs", () => {
    const bt = backtestSpread(series(new Array(60).fill(0.01)), {
      ...PARAMS,
      exitSpreadApr: 0,
    });
    expect(bt.trades).toHaveLength(0);
    expect(bt.intervalsHeld).toBe(0);
  });

  it("THE POINT: a deadband cuts churn on a spread oscillating around zero", () => {
    // A rich spread that repeatedly dips just below zero — exactly the live
    // pattern that produced seven round trips overnight.
    const oscillating: number[] = [];
    for (let i = 0; i < 30; i++) {
      oscillating.push(...new Array(8).fill(0.25), -0.01);
    }

    const naive = backtestSpread(series(oscillating), { ...PARAMS, exitSpreadApr: 0 });
    const banded = backtestSpread(series(oscillating), { ...PARAMS, exitSpreadApr: -0.02 });

    expect(banded.trades.length).toBeLessThan(naive.trades.length);
    // And cutting the round trips must leave more money on the table.
    expect(banded.equity[banded.equity.length - 1].cumReturn).toBeGreaterThan(
      naive.equity[naive.equity.length - 1].cumReturn,
    );
  });

  it("still exits when the spread genuinely inverts past the deadband", () => {
    const flipping = [...new Array(30).fill(0.3), ...new Array(30).fill(-0.3)];
    const bt = backtestSpread(series(flipping), { ...PARAMS, exitSpreadApr: -0.02 });
    expect(bt.trades.length).toBeGreaterThan(0);
    // It must not sit through a sustained inversion forever.
    expect(bt.intervalsHeld).toBeLessThan(flipping.length);
  });
});

describe("sweepExitDeadband", () => {
  it("reports one result per candidate, with churn counts", () => {
    const oscillating: number[] = [];
    for (let i = 0; i < 20; i++) oscillating.push(...new Array(8).fill(0.25), -0.01);

    const sweep = sweepExitDeadband([series(oscillating)], PARAMS, [0, -0.02, -0.05]);
    expect(sweep).toHaveLength(3);
    expect(sweep[0].exitSpreadApr).toBe(0);
    // Wider bands take strictly fewer round trips on an oscillating spread.
    expect(sweep[2].trades).toBeLessThanOrEqual(sweep[0].trades);
  });
});
