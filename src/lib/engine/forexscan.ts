/**
 * Forex opportunity scan — turning FX carry signals into scored, gateable trades.
 *
 * The crypto scanner scores funding carry; this is its forex sibling. It scores
 * **F1 · FX carry** only: hold the higher-yielding currency, earn the interest
 * differential, after the broker swap markup AND the execution spread. Both are
 * charged here, because a carry that ignores either is the trade 68–85% of
 * retail CFD accounts lose money on.
 *
 * F2 · trend is deliberately NOT executed here. The risk gate scores a trade by
 * its measurable net edge, which a carry has and a trend-following bet does not —
 * a trend is a stop-managed directional position, not an edge in basis points.
 * Forcing it through an edge gate would be dishonest bookkeeping, so trend stays
 * a scored signal (see `/api/forex`) until it has a gate built for how it
 * actually works.
 *
 * Every opportunity produced here flows through the SAME paper engine, gate and
 * position accounting as crypto — the forex account's P&L is real paper P&L, not
 * a separate toy ledger.
 */

import { roundTripCost, type LegSpec } from "@/lib/calc/costs";
import { evaluateGate } from "@/lib/calc/gate";
import type { resolveTier } from "@/lib/calc/tiers";
import { computePortfolio, type PortfolioState } from "@/lib/portfolio/sleeves";
import type { SleeveContext } from "@/lib/calc/gate";
import { DEFAULT_SWAP_MARKUP_APR, evaluateFxCarry } from "@/lib/calc/fxsignal";
import { fxSpreadBps, FX_VENUE } from "@/lib/market/fxbook";
import type { FxQuote } from "@/lib/market/forex";
import type { EngineConfig } from "./config";
import { STRATEGY_NAMES, type ScoredOpportunity } from "./scanner";

/** Sleeve context for the FX carry sleeve, or undefined if it is not configured. */
function fxCarrySleeve(portfolio: PortfolioState): SleeveContext | undefined {
  const st = portfolio.sleeves.find((s) => s.def.id === "fx-carry");
  if (!st) return undefined;
  return {
    id: st.def.id,
    name: st.def.name,
    enabled: st.allocation.enabled,
    halted: st.allocation.halted,
    allocatedUsd: st.allocatedUsd,
    deployedUsd: st.deployedUsd,
    maxPositionUsd: st.maxPositionUsd,
    maxLeverage: st.def.limits.maxLeverage,
    maxConcurrentPositions: st.def.limits.maxConcurrentPositions,
    openPositions: 0,
    minimumViableUsd: st.minimumViableUsd,
  };
}

/**
 * The horizon an FX carry is scored over.
 *
 * Crypto funding carry resets every eight hours, so it is scored over a short
 * hold. An FX carry is a different animal: the interest differential accrues
 * slowly and the trade is classically held for months. Scoring it over the
 * crypto hold would understate the carry earned by roughly the ratio of the
 * horizons and reject trades that are genuinely worth holding — so FX carry gets
 * its own, realistically longer, horizon. A quarter is a conservative middle:
 * long enough to earn the differential, short enough not to assume a position is
 * held through a full rate cycle.
 */
export const FX_CARRY_HOLD_DAYS = 90;

export type ForexScanContext = {
  config: EngineConfig;
  quotes: FxQuote[];
  tier: ReturnType<typeof resolveTier>["current"];
  dataAgeSeconds: number;
  halted: boolean;
  swapMarkupApr?: number;
  minNetApr?: number;
};

/**
 * Score every followed pair for FX carry.
 *
 * Sizing: a position targets the sleeve's own per-position cap so the gate has a
 * concrete notional to size down from, matching how the crypto scanner sizes on
 * NAV. Leverage comes from the sleeve (2x for carry), so the capital required is
 * the notional divided by that.
 */
export function scanForex(ctx: ForexScanContext): ScoredOpportunity[] {
  const { config, quotes, tier } = ctx;
  const swapMarkupApr = ctx.swapMarkupApr ?? DEFAULT_SWAP_MARKUP_APR;

  const portfolio = computePortfolio(config.navUsd, config.sleeves);
  const sleeve = fxCarrySleeve(portfolio);

  // Target notional: the sleeve's per-position cap when configured, else a
  // NAV-based fallback so the feed still scores something pre-allocation.
  const targetNotional =
    sleeve && sleeve.maxPositionUsd > 0
      ? sleeve.maxPositionUsd
      : Math.max(config.navUsd * config.legNotionalPctOfNav, config.shadowNotionalUsd);
  const leverage = sleeve?.maxLeverage ?? 2;
  // FX carry is held over its own, longer horizon — not the crypto funding hold.
  const holdDays = FX_CARRY_HOLD_DAYS;

  const out: ScoredOpportunity[] = [];

  for (const q of quotes) {
    const carry = evaluateFxCarry(q, { swapMarkupApr, minNetApr: ctx.minNetApr });
    if (carry.direction === "flat") continue;

    const spreadBps = fxSpreadBps(q.symbol);
    const leg: LegSpec = {
      venue: FX_VENUE,
      market: "spot",
      liquidity: "taker",
      notionalUsd: targetNotional,
      spreadBps,
      depthUsd: 5_000_000,
    };
    const cost = roundTripCost([leg]);

    // Net edge over the hold: the net carry earned, minus what it costs to get
    // in and out. netCarryApr already has the swap markup removed.
    const grossCarryBps = (carry.netCarryApr * holdDays) / 365 * 10_000;
    const netBps = grossCarryBps - cost.totalBps;
    const netApr = holdDays > 0 ? (netBps / 10_000) * (365 / holdDays) : 0;

    // Days to earn back the round-trip spread from the daily net carry.
    const dailyCarryBps = (carry.netCarryApr / 365) * 10_000;
    const breakevenDays = dailyCarryBps > 0 ? cost.totalBps / dailyCarryBps : Infinity;

    const capitalRequiredUsd = targetNotional / Math.max(leverage, 1);
    const side = carry.direction === "long" ? "LONG" : "SHORT";

    const decision = evaluateGate({
      strategyCode: "F1",
      strategyMode: "live",
      tier,
      riskTier: "low",
      sleeve,
      netEdgeBps: netBps,
      minNetEdgeBps: config.minNetEdgeBps,
      intendedNotionalUsd: targetNotional,
      venueMinNotionalUsd: 10,
      minNotionalDragBps: 0,
      breakevenDays,
      expectedHoldDays: holdDays,
      navUsd: config.navUsd,
      freeBalanceUsd: config.navUsd,
      capitalRequiredUsd,
      openPositions: 0,
      riskTierDeployedUsd: 0,
      leverage,
      maxLeverage: config.maxLeverage,
      venueHealthy: true,
      dataAgeSeconds: ctx.dataAgeSeconds,
      // FX fixes are daily; a weekend fix is not stale for our purposes the way a
      // 30-second-old crypto tick is. Allow the pair's own stale flag to be the
      // freshness signal rather than the crypto age budget.
      maxDataAgeSeconds: Number.MAX_SAFE_INTEGER,
      globalHalt: ctx.halted,
      dailyLossLimitHit: false,
    });

    // A weekend/holiday fix is not a tradeable rate — never take on stale FX.
    const staleBlocked = q.stale;
    const wouldTake = decision.allowed && !staleBlocked && carry.viable;

    out.push({
      id: `F1-${q.symbol}`,
      ts: q.ts,
      strategy: "F1",
      strategyName: STRATEGY_NAMES.F1,
      asset: q.symbol,
      route: `fx ${side} ${q.symbol}`,
      riskTier: "low",
      sleeveId: sleeve?.id ?? "fx-carry",
      sleeveName: sleeve?.name ?? "FX Carry",
      grossBps: grossCarryBps,
      feesBps: cost.feeBps,
      spreadBps: cost.spreadBps,
      slippageBps: cost.slippageBps,
      dragBps: 0,
      netBps,
      netApr,
      breakevenDays: Number.isFinite(breakevenDays) ? breakevenDays : null,
      capitalRequiredUsd,
      notionalUsd: targetNotional,
      expectedProfitUsd: (netBps / 10_000) * targetNotional,
      fundingApr: carry.grossCarryApr,
      taken: false,
      wouldTake,
      rejectionCode: wouldTake
        ? null
        : staleBlocked
          ? "market_data_stale"
          : decision.allowed
            ? "net_edge_below_threshold"
            : decision.code,
      rejectionDetail: wouldTake
        ? null
        : staleBlocked
          ? "FX fix is stale (weekend/holiday) — not a tradeable rate"
          : !decision.allowed
            ? decision.detail
            : carry.note,
    });
  }

  return out.sort((a, b) => b.netBps - a.netBps);
}
