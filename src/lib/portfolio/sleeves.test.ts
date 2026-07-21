/**
 * Tests for sleeve allocation and isolation.
 *
 * The assertions that matter most are the isolation ones: a sleeve breaching
 * its own limits must not affect any other sleeve. That property is the entire
 * reason sleeves exist, and it would be easy to break silently.
 */

import { describe, expect, it } from "vitest";
import {
  applyPreset,
  computePortfolio,
  defaultAllocations,
  minimumViableCapital,
  PRESETS,
  reconcileAllocations,
  SLEEVES,
  sleeveById,
  sleeveForStrategy,
  type SleeveAllocation,
} from "./sleeves";
import { evaluateGate, type GateInput, type SleeveContext } from "@/lib/calc/gate";
import { TIERS } from "@/lib/calc/tiers";

const alloc = (over: Partial<Record<string, Partial<SleeveAllocation>>> = {}) =>
  SLEEVES.map((s) => ({
    sleeveId: s.id,
    allocatedUsd: 0,
    enabled: false,
    halted: false,
    ...(over[s.id] ?? {}),
  }));

describe("sleeve definitions", () => {
  it("every strategy code maps to exactly one sleeve", () => {
    const seen = new Map<string, string>();
    for (const s of SLEEVES) {
      for (const code of s.strategies) {
        // Strictly one-to-one. A code under two sleeves always resolves to the
        // first, so the second would never receive its operator's capital.
        expect(seen.has(code), `${code} claimed by two sleeves`).toBe(false);
        seen.set(code, s.id);
      }
    }
  });

  it("risk bands escalate with expected drawdown", () => {
    const core = sleeveById("core")!;
    const systematic = sleeveById("systematic")!;
    const opportunistic = sleeveById("opportunistic")!;
    expect(core.expectedMaxDrawdown).toBeLessThan(systematic.expectedMaxDrawdown);
    expect(systematic.expectedMaxDrawdown).toBeLessThan(opportunistic.expectedMaxDrawdown);
  });

  it("only Core promises a positive floor — the rest can lose money over a year", () => {
    // This is the honest bit. A sleeve whose worst realistic year is positive
    // is a different kind of thing from one whose worst year is −40%.
    expect(sleeveById("core")!.targetAprLow).toBeGreaterThan(0);
    expect(sleeveById("accumulation")!.targetAprLow).toBeLessThan(0);
    expect(sleeveById("systematic")!.targetAprLow).toBeLessThan(0);
    expect(sleeveById("opportunistic")!.targetAprLow).toBeLessThan(0);
  });

  it("the accumulation sleeve is unleveraged", () => {
    // Leverage on a buy-and-hold sleeve converts an ordinary drawdown into a
    // liquidation. It is capped at 1x by definition, not by configuration.
    expect(sleeveById("accumulation")!.limits.maxLeverage).toBe(1);
  });

  it("only Core is enabled by default", () => {
    const d = defaultAllocations();
    expect(d.filter((a) => a.enabled).map((a) => a.sleeveId)).toEqual(["core"]);
  });

  it("routes strategies to their sleeve", () => {
    expect(sleeveForStrategy("L2")!.id).toBe("core");
    expect(sleeveForStrategy("H1")!.id).toBe("systematic");
    expect(sleeveForStrategy("H4")!.id).toBe("opportunistic");
    expect(sleeveForStrategy("NOPE")).toBeUndefined();
  });
});

describe("minimum viable capital", () => {
  it("derives the floor from the venue minimum and the position cap", () => {
    // A sleeve capped at 15% per position needs $10 / 0.15 ≈ $67 before it can
    // place one legal trade at the venue minimum.
    const opp = sleeveById("opportunistic")!;
    expect(minimumViableCapital(opp, 10)).toBeCloseTo(66.67, 1);
  });

  it("a tighter position cap demands more capital", () => {
    const loose = minimumViableCapital(sleeveById("accumulation")!, 10);
    const tight = minimumViableCapital(sleeveById("opportunistic")!, 10);
    expect(tight).toBeGreaterThan(loose);
  });
});

describe("portfolio computation", () => {
  it("treats unallocated NAV as reserve, not as a sleeve", () => {
    const p = computePortfolio(1_000, alloc({ core: { allocatedUsd: 600, enabled: true } }));
    expect(p.totalAllocatedUsd).toBe(600);
    expect(p.reserveUsd).toBe(400);
    expect(p.reserveShare).toBeCloseTo(0.4, 10);
    expect(p.overAllocated).toBe(false);
  });

  it("flags over-allocation", () => {
    const p = computePortfolio(
      1_000,
      alloc({ core: { allocatedUsd: 800, enabled: true }, systematic: { allocatedUsd: 400, enabled: true } }),
    );
    expect(p.overAllocated).toBe(true);
  });

  it("derives per-sleeve limits in absolute dollars", () => {
    const p = computePortfolio(1_000, alloc({ core: { allocatedUsd: 1_000, enabled: true } }));
    const core = p.sleeves.find((s) => s.def.id === "core")!;
    expect(core.dailyLossLimitUsd).toBeCloseTo(1_000 * 0.02, 10);
    expect(core.maxPositionUsd).toBeCloseTo(1_000 * 0.35, 10);
  });

  it("blends expected return over enabled funded sleeves only", () => {
    // A disabled sleeve must not contribute to the advertised return profile.
    const withDisabled = computePortfolio(
      1_000,
      alloc({
        core: { allocatedUsd: 500, enabled: true },
        systematic: { allocatedUsd: 500, enabled: false },
      }),
    );
    const coreOnly = computePortfolio(
      1_000,
      alloc({ core: { allocatedUsd: 500, enabled: true } }),
    );
    expect(withDisabled.blendedAprHigh).toBeCloseTo(coreOnly.blendedAprHigh, 10);
  });

  it("states blended return against total NAV so reserve drag is visible", () => {
    // Half the fund in a sleeve targeting 8-20% is a 4-10% portfolio, not
    // 8-20%. Quoting the sleeve's own range would overstate the portfolio.
    const p = computePortfolio(1_000, alloc({ core: { allocatedUsd: 500, enabled: true } }));
    expect(p.blendedAprLow).toBeCloseTo(0.08 * 0.5, 10);
    expect(p.blendedAprHigh).toBeCloseTo(0.2 * 0.5, 10);
  });

  it("marks a sleeve untradable below its minimum viable capital", () => {
    const p = computePortfolio(100, alloc({ opportunistic: { allocatedUsd: 20, enabled: true } }));
    const opp = p.sleeves.find((s) => s.def.id === "opportunistic")!;
    expect(opp.tradable).toBe(false);
    expect(opp.blockedReason).toContain("minimum viable capital");
  });

  it("distinguishes disabled from halted", () => {
    const p = computePortfolio(
      1_000,
      alloc({
        core: { allocatedUsd: 500, enabled: false },
        systematic: { allocatedUsd: 500, enabled: true, halted: true },
      }),
    );
    expect(p.sleeves.find((s) => s.def.id === "core")!.blockedReason).toBe("Sleeve disabled");
    expect(p.sleeves.find((s) => s.def.id === "systematic")!.blockedReason).toBe(
      "Halted by a risk breach",
    );
  });
});

describe("allocation reconciliation", () => {
  it("scales proportionally rather than rejecting an over-allocated save", () => {
    // Refusing the save would strand the operator on an old config during
    // exactly the moment they are trying to reduce risk.
    const { allocations, adjustments } = reconcileAllocations(
      1_000,
      alloc({
        core: { allocatedUsd: 1_500, enabled: true },
        systematic: { allocatedUsd: 500, enabled: true },
      }),
    );
    const total = allocations.reduce((a, x) => a + x.allocatedUsd, 0);
    expect(total).toBeCloseTo(1_000, 6);
    // Ratios preserved: core was 3x systematic and still is.
    const core = allocations.find((a) => a.sleeveId === "core")!.allocatedUsd;
    const sys = allocations.find((a) => a.sleeveId === "systematic")!.allocatedUsd;
    expect(core / sys).toBeCloseTo(3, 6);
    expect(adjustments).toHaveLength(1);
  });

  it("keeps aspirational allocations when NAV is zero", () => {
    const { allocations } = reconcileAllocations(0, alloc({ core: { allocatedUsd: 500 } }));
    expect(allocations.find((a) => a.sleeveId === "core")!.allocatedUsd).toBe(500);
  });

  it("clamps negative and non-finite allocations to zero", () => {
    const { allocations } = reconcileAllocations(1_000, [
      { sleeveId: "core", allocatedUsd: -50, enabled: true, halted: false },
      { sleeveId: "systematic", allocatedUsd: NaN, enabled: true, halted: false },
    ]);
    expect(allocations.find((a) => a.sleeveId === "core")!.allocatedUsd).toBe(0);
    expect(allocations.find((a) => a.sleeveId === "systematic")!.allocatedUsd).toBe(0);
  });

  it("always returns an entry for every sleeve", () => {
    const { allocations } = reconcileAllocations(1_000, []);
    expect(allocations.map((a) => a.sleeveId).sort()).toEqual(SLEEVES.map((s) => s.id).sort());
  });
});

describe("presets", () => {
  it("every preset allocates within NAV", () => {
    for (const id of Object.keys(PRESETS)) {
      const a = applyPreset(1_000, id, defaultAllocations());
      const total = a.reduce((x, s) => x + s.allocatedUsd, 0);
      expect(total, `${id} over-allocates`).toBeLessThanOrEqual(1_000);
    }
  });

  it("defensive holds no directional exposure", () => {
    const a = applyPreset(1_000, "defensive", defaultAllocations());
    for (const id of ["accumulation", "systematic", "opportunistic"]) {
      expect(a.find((x) => x.sleeveId === id)!.allocatedUsd).toBe(0);
    }
  });

  it("growth carries a materially worse expected drawdown than defensive", () => {
    const d = computePortfolio(1_000, applyPreset(1_000, "defensive", defaultAllocations()));
    const g = computePortfolio(1_000, applyPreset(1_000, "growth", defaultAllocations()));
    expect(g.blendedExpectedDrawdown).toBeGreaterThan(d.blendedExpectedDrawdown * 2);
  });
});

/* ---------------------------------------------------------------- isolation */

const T2 = TIERS.find((t) => t.id === "T2")!;

function sleeveCtx(over: Partial<SleeveContext> = {}): SleeveContext {
  return {
    id: "core",
    name: "Core",
    enabled: true,
    halted: false,
    allocatedUsd: 1_000,
    deployedUsd: 0,
    maxPositionUsd: 350,
    maxLeverage: 3,
    maxConcurrentPositions: 6,
    openPositions: 0,
    minimumViableUsd: 29,
    ...over,
  };
}

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    strategyCode: "L1",
    strategyMode: "live",
    tier: T2,
    riskTier: "low",
    sleeve: sleeveCtx(),
    netEdgeBps: 40,
    minNetEdgeBps: 10,
    intendedNotionalUsd: 300,
    venueMinNotionalUsd: 5,
    minNotionalDragBps: 0,
    breakevenDays: 5,
    expectedHoldDays: 30,
    navUsd: 5_000,
    freeBalanceUsd: 2_000,
    capitalRequiredUsd: 400,
    openPositions: 0,
    riskTierDeployedUsd: 0,
    leverage: 3,
    maxLeverage: 5,
    venueHealthy: true,
    dataAgeSeconds: 2,
    maxDataAgeSeconds: 30,
    globalHalt: false,
    dailyLossLimitHit: false,
    ...over,
  };
}

describe("sleeve isolation in the gate", () => {
  it("allows a clean intent inside a healthy sleeve", () => {
    const d = evaluateGate(gateInput());
    expect(d.allowed).toBe(true);
  });

  it("blocks a disabled sleeve", () => {
    const d = evaluateGate(gateInput({ sleeve: sleeveCtx({ enabled: false }) }));
    if (!d.allowed) expect(d.code).toBe("sleeve_disabled");
    else throw new Error("expected rejection");
  });

  it("blocks a halted sleeve, and says other sleeves are unaffected", () => {
    const d = evaluateGate(gateInput({ sleeve: sleeveCtx({ halted: true }) }));
    if (!d.allowed) {
      expect(d.code).toBe("sleeve_halted");
      expect(d.detail).toContain("other sleeves are unaffected");
    } else throw new Error("expected rejection");
  });

  it("halting one sleeve does not block another", () => {
    // The property the whole design exists for.
    const halted = evaluateGate(
      gateInput({ sleeve: sleeveCtx({ id: "systematic", name: "Systematic", halted: true }) }),
    );
    const healthy = evaluateGate(gateInput({ sleeve: sleeveCtx() }));
    expect(halted.allowed).toBe(false);
    expect(healthy.allowed).toBe(true);
  });

  it("applies the tighter of the sleeve and fund leverage caps", () => {
    const d = evaluateGate(
      gateInput({ leverage: 4, maxLeverage: 10, sleeve: sleeveCtx({ maxLeverage: 3 }) }),
    );
    if (!d.allowed) {
      expect(d.code).toBe("leverage_cap");
      expect(d.detail).toContain("Core");
    } else throw new Error("expected rejection");
  });

  it("enforces the sleeve position count independently of the fund limit", () => {
    const d = evaluateGate(
      gateInput({ openPositions: 0, sleeve: sleeveCtx({ openPositions: 6 }) }),
    );
    if (!d.allowed) expect(d.code).toBe("sleeve_position_cap");
    else throw new Error("expected rejection");
  });

  it("blocks an undercapitalised sleeve", () => {
    const d = evaluateGate(
      gateInput({ sleeve: sleeveCtx({ allocatedUsd: 20, minimumViableUsd: 67 }) }),
    );
    if (!d.allowed) expect(d.code).toBe("sleeve_undercapitalised");
    else throw new Error("expected rejection");
  });

  it("blocks when the sleeve's capital is fully deployed", () => {
    const d = evaluateGate(
      gateInput({ sleeve: sleeveCtx({ allocatedUsd: 1_000, deployedUsd: 1_000 }) }),
    );
    if (!d.allowed) expect(d.code).toBe("sleeve_budget_exhausted");
    else throw new Error("expected rejection");
  });

  it("sizes down to the sleeve position cap", () => {
    const d = evaluateGate(
      gateInput({ intendedNotionalUsd: 900, sleeve: sleeveCtx({ maxPositionUsd: 350 }) }),
    );
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.sizedNotionalUsd).toBeCloseTo(350, 6);
  });

  it("sizes down to remaining sleeve headroom", () => {
    const d = evaluateGate(
      gateInput({
        intendedNotionalUsd: 900,
        sleeve: sleeveCtx({ allocatedUsd: 1_000, deployedUsd: 800, maxPositionUsd: 900 }),
      }),
    );
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.sizedNotionalUsd).toBeCloseTo(200, 6);
  });

  it("a sleeve with spare room cannot lift a fund-level limit", () => {
    // Fund low-risk budget at T2 is 65% of 1,000 = 650, with 600 deployed.
    const d = evaluateGate(
      gateInput({
        navUsd: 1_000,
        riskTierDeployedUsd: 600,
        intendedNotionalUsd: 500,
        venueMinNotionalUsd: 5,
        capitalRequiredUsd: 50,
        freeBalanceUsd: 1_000,
        sleeve: sleeveCtx({ allocatedUsd: 10_000, maxPositionUsd: 5_000 }),
      }),
    );
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.sizedNotionalUsd).toBeCloseTo(50, 6);
  });

  it("still applies fund-level rules when an intent has no sleeve", () => {
    const d = evaluateGate(gateInput({ sleeve: undefined, globalHalt: true }));
    if (!d.allowed) expect(d.code).toBe("global_halt");
    else throw new Error("expected rejection");
  });
});
