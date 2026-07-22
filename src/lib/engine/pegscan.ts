/**
 * L3 · stablecoin peg scan.
 *
 * The trade: buy a stable at a discount to par, sell when the peg restores.
 * Near-riskless when it fires — the "risk" is that the peg does NOT restore,
 * which is why the position carries the ordinary stop backstop rather than a
 * belief. Cheap to run continuously, and in calm markets its honest output is
 * a stream of "deviation below cost" rejections; the scanner's value is being
 * already armed on the day that stops being true.
 *
 * Scored through the SAME edge gate as carry: the deviation to par IS a
 * measurable edge in basis points, so unlike trend it needs no special gate.
 */

import { roundTripCost } from "@/lib/calc/costs";
import { evaluateGate } from "@/lib/calc/gate";
import type { resolveTier } from "@/lib/calc/tiers";
import { computePortfolio, sleeveForStrategy } from "@/lib/portfolio/sleeves";
import type { SleeveContext } from "@/lib/calc/gate";
import { pegDiscount } from "@/lib/market/stables";
import type { Quote } from "@/lib/market/types";
import type { EngineConfig } from "./config";
import { STRATEGY_NAMES, type ScoredOpportunity } from "./scanner";

/**
 * The horizon a peg trade is scored over. Historic depegs on the majors have
 * resolved in hours to a few days; two days is the conservative middle, and
 * the stop covers the case where "resolve" turns out to be the wrong verb.
 */
export const PEG_HOLD_DAYS = 2;

export type PegScanContext = {
  config: EngineConfig;
  /** Stable-asset quotes from fetchStableQuotes. */
  quotes: Quote[];
  tier: ReturnType<typeof resolveTier>["current"];
  dataAgeSeconds: number;
  halted: boolean;
};

function coreSleeve(config: EngineConfig): SleeveContext | undefined {
  const portfolio = computePortfolio(config.navUsd, config.sleeves);
  const def = sleeveForStrategy("L3");
  if (!def) return undefined;
  const st = portfolio.sleeves.find((s) => s.def.id === def.id);
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

export function scanStablePeg(ctx: PegScanContext): ScoredOpportunity[] {
  const { config, quotes, tier } = ctx;
  const sleeve = coreSleeve(config);

  const notional =
    config.navUsd > 0
      ? config.navUsd * config.legNotionalPctOfNav
      : config.shadowNotionalUsd;

  const out: ScoredOpportunity[] = [];

  for (const q of quotes) {
    const discount = pegDiscount(q.ask);

    // Above or at par there is nothing to buy — do not emit noise rows for a
    // healthy peg. The feed's job here is to show the discount side priced.
    if (discount <= 0) continue;

    // Entry at the ask now, exit at par later: one spot leg, round trip.
    const cost = roundTripCost([
      {
        venue: q.venue.toLowerCase(),
        market: "spot",
        liquidity: "taker",
        notionalUsd: notional,
        spreadBps: q.spreadBps,
        depthUsd: q.topOfBookUsd,
      },
    ]);

    const grossBps = discount * 10_000;
    const netBps = grossBps - cost.totalBps;
    const netApr = (netBps / 10_000) * (365 / PEG_HOLD_DAYS);

    const decision = evaluateGate({
      strategyCode: "L3",
      strategyMode: "live",
      tier,
      riskTier: "low",
      sleeve,
      netEdgeBps: netBps,
      minNetEdgeBps: config.minNetEdgeBps,
      intendedNotionalUsd: notional,
      venueMinNotionalUsd: 10,
      minNotionalDragBps: 0,
      // The cost is already netted off above; there is no carry to accrue, so
      // breakeven-vs-hold has nothing further to check.
      breakevenDays: 0,
      expectedHoldDays: PEG_HOLD_DAYS,
      navUsd: config.navUsd,
      freeBalanceUsd: config.navUsd,
      capitalRequiredUsd: notional,
      openPositions: 0,
      riskTierDeployedUsd: 0,
      leverage: 1,
      maxLeverage: config.maxLeverage,
      venueHealthy: true,
      dataAgeSeconds: ctx.dataAgeSeconds,
      maxDataAgeSeconds: config.maxDataAgeSeconds,
      globalHalt: ctx.halted,
      dailyLossLimitHit: false,
    });

    out.push({
      id: `L3-${q.venue}-${q.asset}`,
      ts: q.ts,
      strategy: "L3",
      strategyName: STRATEGY_NAMES.L3,
      asset: q.asset,
      route: `${q.venue} ${q.asset} repeg`,
      riskTier: "low",
      sleeveId: sleeve?.id ?? "core",
      sleeveName: sleeve?.name ?? "Core",
      grossBps,
      feesBps: cost.feeBps,
      spreadBps: cost.spreadBps,
      slippageBps: cost.slippageBps,
      dragBps: 0,
      netBps,
      netApr,
      breakevenDays: null,
      capitalRequiredUsd: notional,
      notionalUsd: notional,
      expectedProfitUsd: (netBps / 10_000) * notional,
      taken: false,
      wouldTake: decision.allowed,
      rejectionCode: decision.allowed ? null : decision.code,
      rejectionDetail: decision.allowed
        ? `${q.asset} at ${(discount * 100).toFixed(3)}% below par`
        : decision.detail,
    });
  }

  return out;
}
