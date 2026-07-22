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
import { evaluateGate, evaluateTrendGate } from "@/lib/calc/gate";
import type { resolveTier } from "@/lib/calc/tiers";
import { computePortfolio, type PortfolioState } from "@/lib/portfolio/sleeves";
import type { SleeveContext } from "@/lib/calc/gate";
import {
  DEFAULT_SWAP_MARKUP_APR,
  evaluateFxCarry,
  evaluateFxTrend,
  trendStopFraction,
} from "@/lib/calc/fxsignal";
import { fxSpreadBps, FX_VENUE } from "@/lib/market/fxbook";
import type { FxQuote } from "@/lib/market/forex";
import type { EngineConfig } from "./config";
import { STRATEGY_NAMES, type ScoredOpportunity } from "./scanner";

/** Sleeve context for one FX sleeve, or undefined if it is not configured. */
function fxSleeve(portfolio: PortfolioState, id: string): SleeveContext | undefined {
  const st = portfolio.sleeves.find((s) => s.def.id === id);
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

const fxCarrySleeve = (p: PortfolioState) => fxSleeve(p, "fx-carry");

/** Loss at the stop as a fraction of the trend sleeve's capital. */
export const TREND_RISK_PER_TRADE = 0.01;

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

export type ForexTrendScanContext = ForexScanContext & {
  /** Daily closes per pair symbol, oldest first — the trend signal's input. */
  closes: Record<string, number[]>;
};

/**
 * Score every followed pair for F2 trend.
 *
 * A trend bet has no net edge in basis points — its expectation lives across
 * many trades — so the economics fields are zero and the decision runs through
 * `evaluateTrendGate`: engaged signal, honest volatility, a real invalidation
 * distance, and a size that fixes the loss at the stop. What IS reported per
 * opportunity is the trend context itself, which the paper engine re-gates
 * against live position state.
 */
export function scanForexTrend(ctx: ForexTrendScanContext): ScoredOpportunity[] {
  const { config, quotes, tier } = ctx;

  const portfolio = computePortfolio(config.navUsd, config.sleeves);
  const sleeve = fxSleeve(portfolio, "fx-trend");
  const leverage = sleeve?.maxLeverage ?? 3;

  const out: ScoredOpportunity[] = [];

  for (const q of quotes) {
    const trend = evaluateFxTrend(q.symbol, ctx.closes[q.symbol] ?? []);
    if (trend.direction === "flat" && !trend.engaged && trend.fast === null) {
      // Not even enough history for the slow average — nothing to report.
      continue;
    }

    const stop = trend.annualisedVol ? trendStopFraction(trend.annualisedVol) : 0;

    const decision = evaluateTrendGate({
      tier,
      sleeve,
      engaged: trend.engaged,
      annualisedVol: trend.annualisedVol,
      stopDistanceFraction: stop,
      targetAnnualVol: config.targetAnnualVol,
      riskPerTradeFraction: TREND_RISK_PER_TRADE,
      openPositions: 0,
      leverage,
      maxLeverage: config.maxLeverage,
      venueMinNotionalUsd: 10,
      staleData: q.stale,
      globalHalt: ctx.halted,
    });

    const side =
      trend.direction === "long" ? "LONG" : trend.direction === "short" ? "SHORT" : "FLAT";
    const sized = decision.allowed ? decision.sizedNotionalUsd : 0;

    out.push({
      id: `F2-${q.symbol}`,
      ts: q.ts,
      strategy: "F2",
      strategyName: STRATEGY_NAMES.F2,
      asset: q.symbol,
      route: `fx ${side} ${q.symbol}`,
      riskTier: "medium",
      sleeveId: sleeve?.id ?? "fx-trend",
      sleeveName: sleeve?.name ?? "FX Trend",
      // No edge claim — see the module comment. The spread cost is still real
      // and reported so the feed shows what entry would cost.
      grossBps: 0,
      feesBps: 0,
      spreadBps: fxSpreadBps(q.symbol),
      slippageBps: 0,
      dragBps: 0,
      netBps: 0,
      netApr: null,
      breakevenDays: null,
      capitalRequiredUsd: sized / Math.max(leverage, 1),
      notionalUsd: sized,
      expectedProfitUsd: 0,
      trend:
        trend.direction === "flat"
          ? undefined
          : {
              direction: trend.direction,
              strengthPct: trend.strengthPct,
              annualisedVol: trend.annualisedVol,
              stopDistanceFraction: stop,
              stale: q.stale,
            },
      taken: false,
      wouldTake: decision.allowed,
      rejectionCode: decision.allowed ? null : decision.code,
      rejectionDetail: decision.allowed ? trend.note : decision.detail,
    });
  }

  return out;
}
