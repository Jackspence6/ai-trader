/**
 * Tests for the funding-carry backtest.
 *
 * The state machine must match the live system exactly: enter only when funding
 * is rich AND persistent, exit the moment it inverts, and never show a profit a
 * trade has not earned back its costs on. Each of those is pinned here with a
 * hand-built funding series.
 */

import { describe, expect, it } from "vitest";
import {
  backtestCarry,
  carryStats,
  INTERVALS_PER_YEAR_8H,
  type FundingPoint,
} from "./carry";

/** Build a series from per-interval rates; apr is derived the same way live is. */
function series(rates: number[]): FundingPoint[] {
  return rates.map((rate, i) => ({
    t: i * 8 * 3600_000,
    rate,
    apr: rate * INTERVALS_PER_YEAR_8H,
  }));
}

const PARAMS = {
  minFundingApr: 0.08,
  minPositiveShare: 0.7,
  regimeWindow: 5,
  roundTripCostFraction: 0.002, // 20bp round trip
  expectedHoldDays: 21,
  minNetEdgeBps: 15,
};

// A per-interval rate whose APR clears the 8% floor comfortably.
const RICH = 0.0005; // ×1095 ≈ 55% APR

describe("backtestCarry", () => {
  it("enters a rich, persistent regime and collects funding", () => {
    // 10 intervals of rich positive funding, never inverts → one open position,
    // no completed trade, funding accumulates.
    const bt = backtestCarry(series(Array(10).fill(RICH)), PARAMS);
    expect(bt.intervalsHeld).toBeGreaterThan(0);
    // Ends up in profit: funding collected exceeds the single entry cost.
    expect(bt.equity[bt.equity.length - 1].cumReturn).toBeGreaterThan(0);
  });

  it("does not enter when funding is below the floor", () => {
    // Tiny positive funding: persistent, but APR well under 8%.
    const bt = backtestCarry(series(Array(10).fill(0.00001)), PARAMS);
    expect(bt.intervalsHeld).toBe(0);
    expect(bt.trades).toHaveLength(0);
  });

  it("does not enter without persistence, even on a rich print", () => {
    // A lone rich spike surrounded by zeros — the classic liquidation artefact.
    const bt = backtestCarry(series([0, 0, 0, 0, RICH, 0, 0]), PARAMS);
    expect(bt.trades).toHaveLength(0);
    expect(bt.intervalsHeld).toBe(0);
  });

  it("exits when funding inverts and books the trade", () => {
    // Rich for a while, then a negative print → exit.
    const bt = backtestCarry(series([...Array(6).fill(RICH), -0.0001, RICH]), PARAMS);
    expect(bt.trades).toHaveLength(1);
    const t = bt.trades[0];
    expect(t.win).toBe(true);
    expect(t.fundingReturn).toBeGreaterThan(0);
  });

  it("books a loss when funding does not cover the round trip", () => {
    // Just clears the entry floor, held only briefly, then inverts: funding
    // earned < the 20bp round trip → a losing trade.
    const thin = 0.0001; // ~11% APR, over the 8% floor but small per interval
    const bt = backtestCarry(
      series([...Array(5).fill(thin), thin, -0.001]),
      { ...PARAMS, minFundingApr: 0.08, roundTripCostFraction: 0.002 },
    );
    expect(bt.trades).toHaveLength(1);
    expect(bt.trades[0].netReturn).toBeLessThan(0);
    expect(bt.trades[0].win).toBe(false);
  });
});

describe("carryStats", () => {
  it("summarises return, win rate and drawdown", () => {
    // Rich, one inversion (booking a winning trade), then rich long enough for
    // the re-entry to recoup its round trip and end in profit.
    const bt = backtestCarry(series([...Array(8).fill(RICH), -0.0001, ...Array(6).fill(RICH)]), PARAMS);
    const s = carryStats(bt);
    expect(s.trades).toBe(1);
    expect(s.totalReturnPct).toBeGreaterThan(0);
    expect(s.timeInMarket).toBeGreaterThan(0);
    expect(s.timeInMarket).toBeLessThanOrEqual(1);
    expect(s.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it("is empty and safe on an empty series", () => {
    const s = carryStats(backtestCarry([], PARAMS));
    expect(s.trades).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.sharpe).toBeNull();
  });
});
