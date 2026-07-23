/**
 * Tests for risk-limit enforcement.
 *
 * The two properties that make the limits trustworthy: a fresh book never
 * false-trips on its opening balance (the high-water mark is seeded from the
 * current value), and a breach is one-way — recovering does not silently
 * un-halt, because that decision belongs to a human.
 */

import { describe, expect, it } from "vitest";
import { evaluateRisk, type RiskState } from "./risk";

const FUND = { dailyLossPct: 0.02, maxDrawdownPct: 0.08 };

function sleeve(id: string, equityUsd: number, over: Partial<{ maxDrawdownPct: number; alreadyHalted: boolean }> = {}) {
  return { id, name: id, equityUsd, maxDrawdownPct: 0.1, alreadyHalted: false, ...over };
}

describe("evaluateRisk — fund level", () => {
  it("does not trip on a fresh book", () => {
    const r = evaluateRisk({ navUsd: 1000, dayKey: "2026-07-22", fund: FUND, sleeves: [], prev: null });
    expect(r.fundBreach).toBeNull();
    expect(r.fundDrawdown).toBe(0);
    expect(r.state.fundHwmUsd).toBe(1000);
  });

  it("ratchets the high-water mark up without a breach", () => {
    const prev: RiskState = { fundHwmUsd: 1000, dayKey: "2026-07-22", dayStartUsd: 1000, sleeveHwmUsd: {} };
    const r = evaluateRisk({ navUsd: 1100, dayKey: "2026-07-22", fund: FUND, sleeves: [], prev });
    expect(r.state.fundHwmUsd).toBe(1100);
    expect(r.fundBreach).toBeNull();
  });

  it("trips a global halt on a drawdown past the limit", () => {
    // HWM 1000, now 900 → 10% drawdown > 8% limit.
    const prev: RiskState = { fundHwmUsd: 1000, dayKey: "2026-07-22", dayStartUsd: 950, sleeveHwmUsd: {} };
    const r = evaluateRisk({ navUsd: 900, dayKey: "2026-07-22", fund: FUND, sleeves: [], prev });
    expect(r.fundBreach?.kind).toBe("drawdown");
  });

  it("trips a global halt on the daily loss limit", () => {
    // Day start 1000, now 970 → 3% daily loss > 2% limit; HWM keeps drawdown under 8%.
    const prev: RiskState = { fundHwmUsd: 1000, dayKey: "2026-07-22", dayStartUsd: 1000, sleeveHwmUsd: {} };
    const r = evaluateRisk({ navUsd: 970, dayKey: "2026-07-22", fund: FUND, sleeves: [], prev });
    expect(r.fundBreach?.kind).toBe("daily_loss");
  });

  it("resets the daily baseline on a new UTC day", () => {
    const prev: RiskState = { fundHwmUsd: 1000, dayKey: "2026-07-22", dayStartUsd: 1000, sleeveHwmUsd: {} };
    // New day: baseline resets to today's NAV, so yesterday's loss doesn't carry.
    const r = evaluateRisk({ navUsd: 970, dayKey: "2026-07-23", fund: FUND, sleeves: [], prev });
    expect(r.state.dayStartUsd).toBe(970);
    expect(r.fundBreach).toBeNull();
  });
});

describe("evaluateRisk — sleeve level (blast-radius isolation)", () => {
  it("halts only the sleeve that breached", () => {
    const prev: RiskState = {
      fundHwmUsd: 1000,
      dayKey: "2026-07-22",
      dayStartUsd: 1000,
      sleeveHwmUsd: { hot: 500, calm: 500 },
    };
    const r = evaluateRisk({
      navUsd: 940,
      dayKey: "2026-07-22",
      fund: FUND,
      // hot down 100/500 = 20% > 10%; calm flat.
      sleeves: [sleeve("hot", 400), sleeve("calm", 500)],
      prev,
    });
    expect(r.sleeveHalts.map((h) => h.id)).toEqual(["hot"]);
  });

  it("does not re-halt a sleeve already halted", () => {
    const prev: RiskState = { fundHwmUsd: 1000, dayKey: "2026-07-22", dayStartUsd: 1000, sleeveHwmUsd: { hot: 500 } };
    const r = evaluateRisk({
      navUsd: 900,
      dayKey: "2026-07-22",
      fund: FUND,
      sleeves: [sleeve("hot", 400, { alreadyHalted: true })],
      prev,
    });
    expect(r.sleeveHalts).toHaveLength(0);
    // Still reported as an active breach, though.
    expect(r.breaches.some((b) => b.id === "hot")).toBe(true);
  });

  it("seeds a new sleeve's high-water mark without tripping", () => {
    const r = evaluateRisk({
      navUsd: 1000,
      dayKey: "2026-07-22",
      fund: FUND,
      sleeves: [sleeve("new", 500)],
      prev: { fundHwmUsd: 1000, dayKey: "2026-07-22", dayStartUsd: 1000, sleeveHwmUsd: {} },
    });
    expect(r.sleeveHalts).toHaveLength(0);
    expect(r.state.sleeveHwmUsd.new).toBe(500);
  });
});

describe("portfolio layer (GOVERNANCE.md)", () => {
  it("halts ALL member sleeves when the portfolio breaches its charter drawdown", () => {
    // Conservative = core + fx-carry, 6% limit. Each sleeve individually is
    // within its own (wider) limit, but together they are down 8% from the
    // portfolio high-water — the portfolio halts both, isolation intact.
    const first = evaluateRisk({
      navUsd: 10_000,
      dayKey: "2026-07-23",
      fund: { dailyLossPct: 0.5, maxDrawdownPct: 0.5 },
      sleeves: [
        { id: "core", name: "Core", equityUsd: 6_000, maxDrawdownPct: 0.5, alreadyHalted: false },
        { id: "fx-carry", name: "FX Carry", equityUsd: 3_000, maxDrawdownPct: 0.5, alreadyHalted: false },
        { id: "systematic", name: "Systematic", equityUsd: 1_000, maxDrawdownPct: 0.5, alreadyHalted: false },
      ],
      prev: null,
    });
    const second = evaluateRisk({
      navUsd: 10_000,
      dayKey: "2026-07-23",
      fund: { dailyLossPct: 0.5, maxDrawdownPct: 0.5 },
      sleeves: [
        { id: "core", name: "Core", equityUsd: 5_500, maxDrawdownPct: 0.5, alreadyHalted: false },
        { id: "fx-carry", name: "FX Carry", equityUsd: 2_780, maxDrawdownPct: 0.5, alreadyHalted: false },
        { id: "systematic", name: "Systematic", equityUsd: 1_000, maxDrawdownPct: 0.5, alreadyHalted: false },
      ],
      prev: first.state,
    });
    const haltedIds = second.sleeveHalts.map((h) => h.id).sort();
    expect(haltedIds).toEqual(["core", "fx-carry"]);
    // The Aggressive portfolio (systematic) is untouched — isolation.
    expect(haltedIds).not.toContain("systematic");
    expect(second.breaches.some((b) => b.scope === "portfolio")).toBe(true);
  });
});
