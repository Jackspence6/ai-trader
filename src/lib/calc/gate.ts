/**
 * The trade gate — the single place an opportunity becomes (or fails to become)
 * an order.
 *
 * DESIGN.md principle 2: risk is a hard gate, not a strategy concern. Strategies
 * propose; this module disposes. A strategy bug should cost a rejected order,
 * not the account.
 *
 * The gate returns a *reason* on every rejection, never a bare boolean. That is
 * principle 4 — every decision is observable. The Signals screen is built
 * entirely from these reasons, and "why is the system not trading?" is the
 * question that is impossible to answer from PnL alone.
 */

import { BPS } from "./costs";
import { riskUnitSize, volatilityTargetSize } from "./sizing";
import type { Tier } from "./tiers";

export type RejectionCode =
  | "net_edge_below_threshold"
  | "below_min_notional"
  | "min_notional_drag"
  | "breakeven_exceeds_hold"
  | "strategy_tier_locked"
  | "strategy_disabled"
  | "risk_budget_exhausted"
  | "position_limit_reached"
  | "insufficient_balance"
  | "venue_degraded"
  | "market_data_stale"
  | "global_halt"
  | "leverage_cap"
  | "daily_loss_limit"
  | "sleeve_disabled"
  | "sleeve_halted"
  | "sleeve_budget_exhausted"
  | "sleeve_position_cap"
  | "sleeve_undercapitalised"
  | "trend_not_engaged";

export const REJECTION_LABELS: Record<RejectionCode, string> = {
  net_edge_below_threshold: "Net edge below threshold",
  below_min_notional: "Below venue minimum notional",
  min_notional_drag: "Minimum-notional drag exceeds edge",
  breakeven_exceeds_hold: "Breakeven longer than expected hold",
  strategy_tier_locked: "Strategy locked at current capital tier",
  strategy_disabled: "Strategy disabled or in shadow mode",
  risk_budget_exhausted: "Risk-tier budget exhausted",
  position_limit_reached: "Concurrent position limit reached",
  insufficient_balance: "Insufficient free balance",
  venue_degraded: "Venue degraded",
  market_data_stale: "Market data stale",
  global_halt: "Global halt active",
  leverage_cap: "Leverage cap exceeded",
  daily_loss_limit: "Daily loss limit hit",
  sleeve_disabled: "Sleeve disabled",
  sleeve_halted: "Sleeve halted by risk breach",
  sleeve_budget_exhausted: "Sleeve capital fully deployed",
  sleeve_position_cap: "Exceeds sleeve position cap",
  sleeve_undercapitalised: "Sleeve below minimum viable capital",
  trend_not_engaged: "No engaged trend to follow",
};

/**
 * The sleeve context an intent is being evaluated against.
 *
 * Present on every intent, because every intent belongs to exactly one sleeve.
 * These limits are checked *in addition to* the fund-level ones, and they are
 * what gives sleeves their blast-radius isolation: a sleeve can be halted, out
 * of capital, or undercapitalised without affecting any other sleeve.
 */
export type SleeveContext = {
  id: string;
  name: string;
  enabled: boolean;
  halted: boolean;
  /** Capital assigned to this sleeve. */
  allocatedUsd: number;
  /** Of that, how much is already in positions. */
  deployedUsd: number;
  /** Largest single position permitted inside this sleeve. */
  maxPositionUsd: number;
  /** Sleeve-specific leverage ceiling. */
  maxLeverage: number;
  maxConcurrentPositions: number;
  openPositions: number;
  /** Capital floor below which the sleeve cannot trade usefully. */
  minimumViableUsd: number;
};

export type GateInput = {
  strategyCode: string;
  strategyMode: "live" | "paper" | "shadow" | "off";
  tier: Tier;
  riskTier: "low" | "medium" | "high";
  /** Omit only for fund-level checks that genuinely have no sleeve. */
  sleeve?: SleeveContext;

  /**
   * Paper mode: simulated fills, no real capital, no exchange reachable.
   *
   * Exempts exactly two checks, and only these:
   *   - `strategy_tier_locked` — the capital ladder governs LIVE capital. T0
   *     explicitly unlocks "live opportunity scoring and paper PnL"
   *     (DESIGN.md §7), so blocking paper on tier would forbid the thing the
   *     tier exists to encourage.
   *   - `risk_budget_exhausted` from the TIER's risk budget — again a
   *     live-capital allocation. Sleeve budgets still apply in full.
   *
   * Everything else is enforced identically: halt, staleness, venue health,
   * economics, breakeven, leverage, sleeve limits, position counts. If paper
   * and live could diverge on those, paper would stop being evidence.
   */
  paperMode?: boolean;

  /** Net edge over the whole expected hold, in bps of leg notional. */
  netEdgeBps: number;
  /** Operator-configured minimum net edge, in bps. */
  minNetEdgeBps: number;

  intendedNotionalUsd: number;
  venueMinNotionalUsd: number;
  minNotionalDragBps: number;

  breakevenDays: number;
  expectedHoldDays: number;

  navUsd: number;
  freeBalanceUsd: number;
  capitalRequiredUsd: number;

  openPositions: number;
  /** USD already deployed in this opportunity's risk tier. */
  riskTierDeployedUsd: number;

  leverage: number;
  maxLeverage: number;

  venueHealthy: boolean;
  dataAgeSeconds: number;
  maxDataAgeSeconds: number;
  globalHalt: boolean;
  dailyLossLimitHit: boolean;
};

export type GateDecision =
  | { allowed: true; sizedNotionalUsd: number }
  | { allowed: false; code: RejectionCode; detail: string };

/**
 * Evaluate every pre-trade check, in a deliberate order: cheapest and most
 * absolute first.
 *
 * The ordering matters for the Signals feed. If the system is halted, we want
 * every rejection to say "global halt" rather than a misleading downstream
 * reason like "edge too thin" — the operator would go tuning thresholds to fix
 * a problem that isn't there.
 */
export function evaluateGate(g: GateInput): GateDecision {
  // --- absolute blocks -----------------------------------------------------

  if (g.globalHalt) {
    return { allowed: false, code: "global_halt", detail: "Trading halted globally" };
  }

  if (g.dailyLossLimitHit) {
    return {
      allowed: false,
      code: "daily_loss_limit",
      detail: "Daily loss limit reached; trading suspended until reset",
    };
  }

  if (!g.venueHealthy) {
    return { allowed: false, code: "venue_degraded", detail: "Venue connection degraded" };
  }

  if (g.dataAgeSeconds > g.maxDataAgeSeconds) {
    return {
      allowed: false,
      code: "market_data_stale",
      detail: `Data ${g.dataAgeSeconds.toFixed(0)}s old, limit ${g.maxDataAgeSeconds}s`,
    };
  }

  // --- permission ----------------------------------------------------------

  if (g.strategyMode !== "live") {
    return {
      allowed: false,
      code: "strategy_disabled",
      detail: `Strategy is in ${g.strategyMode} mode`,
    };
  }

  if (!g.paperMode && !g.tier.liveStrategies.includes(g.strategyCode)) {
    return {
      allowed: false,
      code: "strategy_tier_locked",
      detail: `${g.strategyCode} is not live-eligible at tier ${g.tier.id}`,
    };
  }

  // --- sleeve permission ---------------------------------------------------
  //
  // Checked here rather than alongside the fund-level capacity rules, because a
  // disabled or halted sleeve is a statement about permission, not capacity —
  // and reporting it as "budget exhausted" would send the operator to add
  // capital when what they need to do is un-halt the sleeve.

  if (g.sleeve) {
    const s = g.sleeve;

    if (!s.enabled) {
      return {
        allowed: false,
        code: "sleeve_disabled",
        detail: `${s.name} sleeve is switched off`,
      };
    }

    if (s.halted) {
      return {
        allowed: false,
        code: "sleeve_halted",
        detail: `${s.name} sleeve halted by a risk breach; other sleeves are unaffected`,
      };
    }

    if (s.allocatedUsd < s.minimumViableUsd) {
      return {
        allowed: false,
        code: "sleeve_undercapitalised",
        detail: `${s.name} has $${s.allocatedUsd.toFixed(2)}, needs $${s.minimumViableUsd.toFixed(2)} to place a position without breaching its own cap`,
      };
    }

    // The tighter of the two leverage ceilings always wins.
    if (g.leverage > s.maxLeverage) {
      return {
        allowed: false,
        code: "leverage_cap",
        detail: `Requested ${g.leverage}x exceeds the ${s.name} sleeve cap of ${s.maxLeverage}x`,
      };
    }

    if (s.openPositions >= s.maxConcurrentPositions) {
      return {
        allowed: false,
        code: "sleeve_position_cap",
        detail: `${s.openPositions}/${s.maxConcurrentPositions} positions open in ${s.name}`,
      };
    }
  }

  if (g.leverage > g.maxLeverage) {
    return {
      allowed: false,
      code: "leverage_cap",
      detail: `Requested ${g.leverage}x exceeds cap ${g.maxLeverage}x`,
    };
  }

  // --- economics -----------------------------------------------------------
  //
  // Checked before capacity: an unprofitable trade should be reported as
  // unprofitable even when we also happen to be out of room, because that is
  // the more actionable fact.

  if (g.intendedNotionalUsd < g.venueMinNotionalUsd) {
    return {
      allowed: false,
      code: "below_min_notional",
      detail: `Size $${g.intendedNotionalUsd.toFixed(2)} below venue minimum $${g.venueMinNotionalUsd.toFixed(2)}`,
    };
  }

  // The universal minimum-viable-trade filter from DESIGN.md §7. This runs at
  // every tier and is the real protection against small-balance value
  // destruction: edge must clear costs *including* the drag from being forced
  // up to a venue minimum.
  const effectiveEdgeBps = g.netEdgeBps - g.minNotionalDragBps;

  if (g.minNotionalDragBps > 0 && effectiveEdgeBps <= 0) {
    return {
      allowed: false,
      code: "min_notional_drag",
      detail: `Drag ${g.minNotionalDragBps.toFixed(1)}bp exceeds edge ${g.netEdgeBps.toFixed(1)}bp`,
    };
  }

  if (effectiveEdgeBps < g.minNetEdgeBps) {
    return {
      allowed: false,
      code: "net_edge_below_threshold",
      detail: `Net ${effectiveEdgeBps.toFixed(1)}bp below threshold ${g.minNetEdgeBps.toFixed(1)}bp`,
    };
  }

  // A position whose costs take longer to repay than we intend to hold it is a
  // guaranteed loss, however attractive the annualised headline looks.
  if (g.breakevenDays > g.expectedHoldDays) {
    return {
      allowed: false,
      code: "breakeven_exceeds_hold",
      detail: `Breakeven ${g.breakevenDays.toFixed(1)}d exceeds expected hold ${g.expectedHoldDays.toFixed(1)}d`,
    };
  }

  // --- capacity ------------------------------------------------------------

  if (g.openPositions >= g.tier.maxConcurrentPositions) {
    return {
      allowed: false,
      code: "position_limit_reached",
      detail: `${g.openPositions}/${g.tier.maxConcurrentPositions} positions open at tier ${g.tier.id}`,
    };
  }

  // The tier's risk budget allocates LIVE capital, so it does not bind paper.
  // Sleeve budgets are enforced below regardless of mode.
  const budgetFraction = g.tier.riskBudget[g.riskTier];
  const budgetUsd = g.navUsd * budgetFraction;
  const budgetHeadroom = g.paperMode ? Infinity : budgetUsd - g.riskTierDeployedUsd;

  if (!g.paperMode) {
    if (budgetFraction <= 0) {
      return {
        allowed: false,
        code: "risk_budget_exhausted",
        detail: `Tier ${g.tier.id} allocates 0% to ${g.riskTier} risk`,
      };
    }

    if (budgetHeadroom <= 0) {
      return {
        allowed: false,
        code: "risk_budget_exhausted",
        detail: `${g.riskTier} budget $${budgetUsd.toFixed(2)} fully deployed`,
      };
    }

    if (g.capitalRequiredUsd > g.freeBalanceUsd) {
      return {
        allowed: false,
        code: "insufficient_balance",
        detail: `Needs $${g.capitalRequiredUsd.toFixed(2)}, free $${g.freeBalanceUsd.toFixed(2)}`,
      };
    }
  }

  // --- sizing --------------------------------------------------------------
  //
  // Everything passed. Size is the smallest of what we wanted, what the risk
  // budget allows, and what we can actually fund.

  const fundableNotional =
    g.paperMode || g.capitalRequiredUsd <= 0
      ? g.intendedNotionalUsd
      : (g.freeBalanceUsd / g.capitalRequiredUsd) * g.intendedNotionalUsd;

  const limits = [g.intendedNotionalUsd, budgetHeadroom, fundableNotional];

  // Sleeve constraints are additional ceilings, never a way to size *up*. A
  // sleeve with room to spare cannot lift a fund-level limit.
  if (g.sleeve) {
    const s = g.sleeve;
    const sleeveHeadroom = s.allocatedUsd - s.deployedUsd;

    if (sleeveHeadroom <= 0) {
      return {
        allowed: false,
        code: "sleeve_budget_exhausted",
        detail: `${s.name} has $${s.allocatedUsd.toFixed(2)} allocated, all of it deployed`,
      };
    }

    // Headroom is CAPITAL; the other limits are NOTIONAL. A carry consumes
    // notional × (1 + 1/L) of capital, so sizing notional straight to the
    // headroom would overdraw the sleeve by the margin factor. Convert using
    // this trade's own capital-per-notional ratio.
    const capitalPerNotional =
      g.intendedNotionalUsd > 0 && g.capitalRequiredUsd > 0
        ? g.capitalRequiredUsd / g.intendedNotionalUsd
        : 1;
    limits.push(sleeveHeadroom / capitalPerNotional, s.maxPositionUsd);
  }

  const sized = Math.min(...limits);

  if (sized < g.venueMinNotionalUsd) {
    return {
      allowed: false,
      code: "below_min_notional",
      detail: `Post-limit size $${sized.toFixed(2)} below venue minimum`,
    };
  }

  return { allowed: true, sizedNotionalUsd: sized };
}

/** Expected profit in USD for a sized opportunity at a given net edge. */
export function expectedProfitUsd(notionalUsd: number, netEdgeBps: number): number {
  return (netEdgeBps / BPS) * notionalUsd;
}

/* ------------------------------------------------------------- trend gate */

export type TrendGateInput = {
  tier: Tier;
  sleeve?: SleeveContext;
  /** See GateInput.paperMode — exempts the tier's live-capital locks only. */
  paperMode?: boolean;

  /** Whether the trend signal has actually taken a side. */
  engaged: boolean;
  /** Pair's annualised volatility. Null means it cannot be sized honestly. */
  annualisedVol: number | null;
  /** Invalidation distance as a fraction of price. */
  stopDistanceFraction: number;
  /** Portfolio vol target (config.targetAnnualVol). */
  targetAnnualVol: number;
  /** Loss at the stop, as a fraction of sleeve capital. */
  riskPerTradeFraction: number;

  /** Logical positions open in this account, against the tier's budget. */
  openPositions: number;
  leverage: number;
  maxLeverage: number;
  venueMinNotionalUsd: number;
  staleData: boolean;
  globalHalt: boolean;
};

/**
 * The gate for stop-managed directional trades (F2 trend, later H1).
 *
 * Deliberately NOT `evaluateGate`. That gate's centre is a measurable net edge
 * in basis points, which a carry has and a trend bet does not — a trend's
 * expectation lives in the distribution of many trades, not in any single
 * entry. Forcing trend through an edge threshold would either reject it always
 * (edge 0 < any floor) or require inventing an edge number, which is dishonest
 * bookkeeping. What a trend trade CAN honestly promise is bounded loss:
 * a real invalidation level and a size chosen so being wrong costs a fixed
 * fraction of the sleeve. That is what this gate checks.
 *
 * Sizing takes the tightest of: volatility targeting (equalises risk across
 * pairs), risk-unit sizing (fixes the loss at the stop), sleeve headroom
 * (converted from capital to notional at the sleeve's leverage), and the
 * sleeve's per-position cap.
 */
export function evaluateTrendGate(g: TrendGateInput): GateDecision {
  if (g.globalHalt) {
    return { allowed: false, code: "global_halt", detail: "Trading halted globally" };
  }

  if (g.staleData) {
    return {
      allowed: false,
      code: "market_data_stale",
      detail: "FX fix is stale (weekend/holiday) — not a tradeable rate",
    };
  }

  if (!g.sleeve) {
    return {
      allowed: false,
      code: "sleeve_disabled",
      detail: "No sleeve configured for this strategy",
    };
  }
  const s = g.sleeve;

  if (!s.enabled) {
    return { allowed: false, code: "sleeve_disabled", detail: `${s.name} sleeve is switched off` };
  }
  if (s.halted) {
    return {
      allowed: false,
      code: "sleeve_halted",
      detail: `${s.name} sleeve halted by a risk breach; other sleeves are unaffected`,
    };
  }
  if (s.allocatedUsd < s.minimumViableUsd) {
    return {
      allowed: false,
      code: "sleeve_undercapitalised",
      detail: `${s.name} has $${s.allocatedUsd.toFixed(2)}, needs $${s.minimumViableUsd.toFixed(2)}`,
    };
  }
  if (g.leverage > Math.min(s.maxLeverage, g.maxLeverage)) {
    return {
      allowed: false,
      code: "leverage_cap",
      detail: `Requested ${g.leverage}x exceeds the ${s.name} cap of ${Math.min(s.maxLeverage, g.maxLeverage)}x`,
    };
  }
  if (s.openPositions >= s.maxConcurrentPositions) {
    return {
      allowed: false,
      code: "sleeve_position_cap",
      detail: `${s.openPositions}/${s.maxConcurrentPositions} positions open in ${s.name}`,
    };
  }

  if (!g.engaged) {
    return {
      allowed: false,
      code: "trend_not_engaged",
      detail: "Averages entangled — ranging market, staying flat",
    };
  }
  if (g.annualisedVol === null || g.annualisedVol <= 0) {
    return {
      allowed: false,
      code: "trend_not_engaged",
      detail: "No volatility history — cannot size the position honestly",
    };
  }
  if (g.stopDistanceFraction <= 0) {
    return {
      allowed: false,
      code: "trend_not_engaged",
      detail: "No invalidation distance — a trend trade without a stop is not takeable",
    };
  }

  if (g.openPositions >= g.tier.maxConcurrentPositions) {
    return {
      allowed: false,
      code: "position_limit_reached",
      detail: `${g.openPositions}/${g.tier.maxConcurrentPositions} positions open at tier ${g.tier.id}`,
    };
  }

  // The tier's risk budget is a live-capital allocation; medium-risk trend is
  // budget-gated live exactly like the edge gate does it.
  if (!g.paperMode && g.tier.riskBudget.medium <= 0) {
    return {
      allowed: false,
      code: "risk_budget_exhausted",
      detail: `Tier ${g.tier.id} allocates 0% to medium risk`,
    };
  }

  const headroomUsd = s.allocatedUsd - s.deployedUsd;
  if (headroomUsd <= 0) {
    return {
      allowed: false,
      code: "sleeve_budget_exhausted",
      detail: `${s.name} has $${s.allocatedUsd.toFixed(2)} allocated, all of it deployed`,
    };
  }

  const maxFraction = s.allocatedUsd > 0 ? s.maxPositionUsd / s.allocatedUsd : 0;
  const lev = Math.max(g.leverage, 1);
  const sized = Math.min(
    volatilityTargetSize(s.allocatedUsd, g.targetAnnualVol, g.annualisedVol, maxFraction),
    riskUnitSize(s.allocatedUsd, g.riskPerTradeFraction, g.stopDistanceFraction, maxFraction),
    // FX is margined, so headroom capital funds leverage × as much notional.
    headroomUsd * lev,
    s.maxPositionUsd,
  );

  if (sized < g.venueMinNotionalUsd) {
    return {
      allowed: false,
      code: "below_min_notional",
      detail: `Sized $${sized.toFixed(2)} below venue minimum $${g.venueMinNotionalUsd.toFixed(2)}`,
    };
  }

  return { allowed: true, sizedNotionalUsd: sized };
}
