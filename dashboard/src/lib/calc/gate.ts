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
  | "daily_loss_limit";

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
};

export type GateInput = {
  strategyCode: string;
  strategyMode: "live" | "paper" | "shadow" | "off";
  tier: Tier;
  riskTier: "low" | "medium" | "high";

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

  if (!g.tier.liveStrategies.includes(g.strategyCode)) {
    return {
      allowed: false,
      code: "strategy_tier_locked",
      detail: `${g.strategyCode} is not live-eligible at tier ${g.tier.id}`,
    };
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

  const budgetFraction = g.tier.riskBudget[g.riskTier];
  const budgetUsd = g.navUsd * budgetFraction;
  const budgetHeadroom = budgetUsd - g.riskTierDeployedUsd;

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

  // --- sizing --------------------------------------------------------------
  //
  // Everything passed. Size is the smallest of what we wanted, what the risk
  // budget allows, and what we can actually fund.

  const fundableNotional =
    g.capitalRequiredUsd > 0
      ? (g.freeBalanceUsd / g.capitalRequiredUsd) * g.intendedNotionalUsd
      : g.intendedNotionalUsd;

  const sized = Math.min(g.intendedNotionalUsd, budgetHeadroom, fundableNotional);

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
