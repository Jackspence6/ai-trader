/**
 * The capital ladder (DESIGN.md §7).
 *
 * Capability is gated on NAV because the arithmetic of fees and exchange
 * minimums does not scale down with account size. The ladder is a first-class
 * object the engine reads on every decision, not a documentation table.
 *
 * Promotion requires the threshold to hold for 7 consecutive days so a lucky
 * spike cannot unlock leverage. Demotion is immediate on breach. That asymmetry
 * is deliberate: protecting capital should not wait for confirmation.
 */

export type TierId = "T0" | "T1" | "T2" | "T3" | "T4" | "T5";

export type Tier = {
  id: TierId;
  name: string;
  minNavUsd: number;
  maxNavUsd: number | null;
  /** Strategy codes this tier permits to trade live. */
  liveStrategies: string[];
  /** Max share of NAV allocatable to each risk tier. */
  riskBudget: { low: number; medium: number; high: number };
  maxConcurrentPositions: number;
  maxVenues: number;
  unlocks: string[];
  rationale: string;
};

export const TIERS: Tier[] = [
  {
    id: "T0",
    name: "Seed",
    minNavUsd: 0,
    maxNavUsd: 500,
    liveStrategies: [],
    riskBudget: { low: 0, medium: 0, high: 0 },
    maxConcurrentPositions: 1,
    maxVenues: 1,
    unlocks: [
      "All strategies in shadow mode",
      "Full market-data recording",
      "Live opportunity scoring and paper PnL",
      "One optional micro-position as an order-path test",
    ],
    rationale:
      "Below this, fees and exchange minimums exceed almost every edge. The valuable output of this tier is evidence, not returns.",
  },
  {
    id: "T1",
    name: "Starter",
    minNavUsd: 500,
    maxNavUsd: 2_500,
    // Realigned 2026-07-26. The original T1 was written for a single-book
    // fund: L1+F1 only, one position per account. The portfolio charter
    // (GOVERNANCE.md) now decides WHICH strategies hold capital — with
    // evidence, per-sleeve caps and drawdown halts — and the operator's
    // standing instruction funds all three portfolios at this NAV. A ladder
    // that silently forbade two funded books from ever trading was two
    // governance layers contradicting each other; the book sat frozen at its
    // first two entries for three days proving it. The ladder's job at this
    // scale is concurrency and size, not strategy selection: three slots per
    // account so a carry position cannot permanently starve the trend book,
    // and a medium budget matching the charter's Aggressive cap (25%).
    liveStrategies: ["L1", "L3", "F1", "F2", "H1"],
    riskBudget: { low: 0.65, medium: 0.25, high: 0 },
    maxConcurrentPositions: 3,
    maxVenues: 1,
    unlocks: [
      "Funding carry live on one venue",
      "Charter-funded trend books (H1 crypto, F2 tuition) within sleeve caps",
      "Peg scanner armed",
      "Medium risk up to the charter's Aggressive cap",
    ],
    rationale:
      "The simplest configuration in which every charter-funded book can actually trade. Sleeve allocations and per-trade stops bound each position; the ladder bounds how many can pile up.",
  },
  {
    id: "T2",
    name: "Core",
    minNavUsd: 2_500,
    maxNavUsd: 10_000,
    liveStrategies: ["L1", "L2", "L3", "F1", "F2", "H1", "M2"],
    riskBudget: { low: 0.65, medium: 0.25, high: 0 },
    maxConcurrentPositions: 4,
    maxVenues: 2,
    unlocks: [
      "Multi-venue funding carry",
      "Cross-venue funding spread",
      "Stablecoin peg scanner live",
      "Medium risk tier up to 15%",
    ],
    rationale:
      "Enough capital to hold margin on two venues simultaneously, which is the precondition for every cross-venue strategy.",
  },
  {
    id: "T3",
    name: "Expansion",
    minNavUsd: 10_000,
    maxNavUsd: 50_000,
    liveStrategies: ["L1", "L2", "L3", "M1", "M2", "F1", "F2", "H1"],
    riskBudget: { low: 0.6, medium: 0.3, high: 0.05 },
    maxConcurrentPositions: 8,
    maxVenues: 3,
    unlocks: [
      "Cross-venue spot spread with pre-funded inventory",
      "Basis / calendar spreads",
      "High risk tier up to 5%",
    ],
    rationale:
      "Inventory spread across multiple venues finally clears per-venue minimums with room to size properly.",
  },
  {
    id: "T4",
    name: "Scale",
    minNavUsd: 50_000,
    maxNavUsd: 250_000,
    liveStrategies: ["L1", "L2", "L3", "M1", "M2", "M3", "H1", "H2", "F1", "F2"],
    riskBudget: { low: 0.55, medium: 0.35, high: 0.1 },
    maxConcurrentPositions: 16,
    maxVenues: 4,
    unlocks: [
      "Passive market making",
      "Meta-allocator enabled",
      "Wider venue set",
      "Paid low-latency infrastructure now justifiable",
    ],
    rationale:
      "Fee tiers improve and maker rebates become real income rather than a rounding error.",
  },
  {
    id: "T5",
    name: "Institutional",
    minNavUsd: 250_000,
    maxNavUsd: null,
    liveStrategies: ["L1", "L2", "L3", "M1", "M2", "M3", "H1", "H2", "H3", "H4", "F1", "F2"],
    riskBudget: { low: 0.5, medium: 0.35, high: 0.15 },
    maxConcurrentPositions: 32,
    maxVenues: 6,
    unlocks: ["Full strategy set", "VIP fee tiers", "Colocation worth evaluating"],
    rationale: "",
  },
];

/** The tier a given NAV falls into, ignoring the hold-period requirement. */
export function tierForNav(navUsd: number): Tier {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (navUsd >= TIERS[i].minNavUsd) return TIERS[i];
  }
  return TIERS[0];
}

export const PROMOTION_HOLD_DAYS = 7;

export type TierState = {
  current: Tier;
  /** The tier NAV alone would imply right now. */
  implied: Tier;
  next: Tier | null;
  /** Progress toward the next tier's threshold, 0–1. */
  progress: number;
  usdToNext: number | null;
  /** True when NAV qualifies for promotion but the hold period is unmet. */
  awaitingPromotion: boolean;
  daysHeldAboveThreshold: number;
  daysUntilPromotion: number;
};

/**
 * Resolve the effective tier from NAV plus how long NAV has held above the
 * threshold.
 *
 * Demotion applies immediately — if NAV has fallen below the current tier's
 * floor, the implied (lower) tier is returned with no grace period.
 */
export function resolveTier(
  navUsd: number,
  daysHeldAboveThreshold: number,
  currentTierId: TierId,
): TierState {
  const implied = tierForNav(navUsd);
  const currentIdx = TIERS.findIndex((t) => t.id === currentTierId);
  const impliedIdx = TIERS.findIndex((t) => t.id === implied.id);
  const safeCurrentIdx = currentIdx === -1 ? 0 : currentIdx;

  let effectiveIdx: number;
  let awaitingPromotion = false;

  if (impliedIdx < safeCurrentIdx) {
    // Demotion: immediate, no confirmation period.
    effectiveIdx = impliedIdx;
  } else if (impliedIdx > safeCurrentIdx) {
    // Promotion: only after the hold period.
    if (daysHeldAboveThreshold >= PROMOTION_HOLD_DAYS) {
      effectiveIdx = impliedIdx;
    } else {
      effectiveIdx = safeCurrentIdx;
      awaitingPromotion = true;
    }
  } else {
    effectiveIdx = safeCurrentIdx;
  }

  const current = TIERS[effectiveIdx];
  const next = TIERS[effectiveIdx + 1] ?? null;

  const progress = next
    ? Math.min(
        Math.max(
          (navUsd - current.minNavUsd) / (next.minNavUsd - current.minNavUsd),
          0,
        ),
        1,
      )
    : 1;

  return {
    current,
    implied,
    next,
    progress,
    usdToNext: next ? Math.max(next.minNavUsd - navUsd, 0) : null,
    awaitingPromotion,
    daysHeldAboveThreshold,
    daysUntilPromotion: Math.max(
      PROMOTION_HOLD_DAYS - daysHeldAboveThreshold,
      0,
    ),
  };
}

/** Whether a strategy code may hold live capital at this tier. */
export function isStrategyLiveEligible(tier: Tier, strategyCode: string): boolean {
  return tier.liveStrategies.includes(strategyCode);
}

/** The tier at which a strategy first becomes live-eligible, if ever. */
export function unlockTierFor(strategyCode: string): TierId | null {
  for (const t of TIERS) {
    if (t.liveStrategies.includes(strategyCode)) return t.id;
  }
  return null;
}
