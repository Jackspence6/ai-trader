/**
 * Paper-trading engine.
 *
 * Turns scored opportunities into intents, runs them through the same risk gate
 * live trading would use, and executes the survivors against the simulated
 * venue. This is the ROADMAP B2 gate: identical code, live market data,
 * simulated fills, and it is mandatory before any strategy sees real capital.
 *
 * The mode is explicit and total. There is no flag that turns this into live
 * trading, and no live `Venue` implementation exists for it to switch to. When
 * one is written it will be a separate, deliberate step — not a boolean.
 *
 * What paper trading is actually FOR, and why it is worth the code:
 *
 *   1. Predicted vs realised edge. The scanner says an opportunity is worth
 *      40bp; the fill says what it actually cost. Divergence means the cost
 *      model is wrong, and everything downstream of the cost model — every
 *      threshold, every sleeve limit — is wrong with it.
 *   2. It makes sleeve limits real. Until positions existed, a sleeve's
 *      drawdown limit was a number with nothing measuring against it.
 *   3. It exercises the order path end to end while the blast radius is zero.
 */

import { evaluateGate, type GateInput, type RejectionCode } from "@/lib/calc/gate";
import { resolveTier, type Tier } from "@/lib/calc/tiers";
import { bindingMinNotional } from "@/lib/calc/costs";
import { computePortfolio, sleeveForStrategy } from "@/lib/portfolio/sleeves";
import {
  buildPositions,
  countLogicalPositions,
  markPositions,
  type Fill,
  type FundingPayment,
  type MarkedPosition,
} from "@/lib/portfolio/positions";
import type { ScoredOpportunity } from "@/lib/engine/scanner";
import type { EngineConfig } from "@/lib/engine/config";
import type { SimulatedVenue } from "./simulated";
import { newIntentId, type Order, type OrderIntent } from "./types";

export type PaperDecision = {
  opportunityId: string;
  asset: string;
  strategy: string;
  sleeveId: string;
  executed: boolean;
  /** Set when the gate or the venue refused. */
  rejectionCode: RejectionCode | "venue_rejected" | "no_position_plan" | null;
  detail: string | null;
  orders: Order[];
  fills: Fill[];
  /** Net edge the scanner predicted over the whole hold, in bps. */
  predictedNetBps: number;
  /**
   * Entry cost the scanner PREDICTED, in bps of leg notional.
   *
   * Derived as half the round-trip cost, since the scanner models entry and
   * exit symmetrically. This is the number the realised cost is compared
   * against — comparing realised cost to predicted NET EDGE would be comparing
   * two different quantities and the resulting "error" would mean nothing.
   */
  predictedEntryCostBps: number;
  /** Cost actually paid on entry, in bps of notional. Null when not executed. */
  realisedEntryCostBps: number | null;
};

export type PaperRunResult = {
  ts: number;
  decisions: PaperDecision[];
  executed: number;
  rejected: number;
  fills: Fill[];
};

/**
 * Turn one opportunity into the legs it actually requires.
 *
 * A funding carry is TWO orders — long spot, short perp — and they only work
 * as a pair. Modelling it as a single order would produce a directional
 * position wearing a market-neutral label, which is the most dangerous kind of
 * bookkeeping error available here.
 */
function planLegs(
  opp: ScoredOpportunity,
  notionalUsd: number,
  prices: Map<string, number>,
): { venue: string; market: "spot" | "perp"; side: "buy" | "sell" }[] | null {
  const price = prices.get(opp.asset);
  if (!price || price <= 0) return null;

  if (opp.strategy === "L1") {
    // "Binance spot ⇄ Binance perp" — same venue, both legs.
    const venue = opp.route.split(" ")[0];
    return [
      { venue, market: "spot", side: "buy" },
      { venue, market: "perp", side: "sell" },
    ];
  }

  if (opp.strategy === "L2") {
    // "Short Hyperliquid ⇄ Long Bybit"
    const m = opp.route.match(/^Short (\S+) ⇄ Long (\S+)$/);
    if (!m) return null;
    return [
      { venue: m[1], market: "perp", side: "sell" },
      { venue: m[2], market: "perp", side: "buy" },
    ];
  }

  return null;
}

/**
 * The entry cost the scanner predicted, in bps of one leg's notional.
 *
 * The scanner's fee/spread/slippage figures are ROUND TRIP — it models entry
 * and exit symmetrically — so entry alone is half.
 */
function predictedEntryCost(opp: ScoredOpportunity): number {
  return (opp.feesBps + opp.spreadBps + opp.slippageBps) / 2;
}

export type PaperContext = {
  config: EngineConfig;
  opportunities: ScoredOpportunity[];
  venue: SimulatedVenue;
  prices: Map<string, number>;
  halted: boolean;
  dataAgeSeconds: number;
  daysHeldAboveThreshold?: number;
  /** Existing fills, so position limits account for what is already open. */
  existingFills?: Fill[];
  funding?: FundingPayment[];
};

/**
 * Run one paper-trading pass.
 *
 * Every scored opportunity is considered, and this engine runs its own gate
 * over all of them. It deliberately does NOT pre-filter on the scanner's
 * `wouldTake`: that verdict is computed against the *live* gate, which blocks
 * on the capital tier — so filtering on it would make paper trading impossible
 * at T0, which is exactly the tier that DESIGN.md §7 says should be producing
 * paper PnL.
 *
 * The gate here sees live position state, which the scanner cannot: the scanner
 * scores each opportunity in isolation and has no idea how much room a sleeve
 * has left after earlier fills in this same pass.
 */
export async function runPaperPass(ctx: PaperContext): Promise<PaperRunResult> {
  const { config, opportunities, venue, prices } = ctx;

  const tierState = resolveTier(config.navUsd, ctx.daysHeldAboveThreshold ?? 0, "T0");
  const tier: Tier = tierState.current;

  // Position state is rebuilt as we go so that each intent sees the effect of
  // the ones before it in this same pass. Evaluating them all against the
  // opening state would let a sleeve be filled several times over.
  const fills: Fill[] = [...(ctx.existingFills ?? [])];
  const newFills: Fill[] = [];
  const decisions: PaperDecision[] = [];

  // Sorted by net edge so that when a sleeve runs out of room, it ran out on
  // the best opportunities rather than on whichever happened to be first.
  const candidates = [...opportunities].sort((a, b) => b.netBps - a.netBps);

  for (const opp of candidates) {
    const sleeveDef = sleeveForStrategy(opp.strategy);
    const sleeveId = sleeveDef?.id ?? "unassigned";

    const portfolio = computePortfolio(config.navUsd, config.sleeves);
    const sleeveState = portfolio.sleeves.find((s) => s.def.id === sleeveId);

    const marked = markPositions(buildPositions(fills, ctx.funding), prices);
    const sleevePositions = marked.filter((p) => p.sleeveId === sleeveId && p.qty !== 0);
    const deployedUsd = sleevePositions.reduce(
      (a, p) => a + Math.abs(p.marketValueUsd ?? 0),
      0,
    );

    const notionalUsd = opp.notionalUsd;

    const gateInput: GateInput = {
      strategyCode: opp.strategy,
      strategyMode: "paper",
      tier,
      riskTier: opp.riskTier,
      sleeve: sleeveState
        ? {
            id: sleeveState.def.id,
            name: sleeveState.def.name,
            enabled: sleeveState.allocation.enabled,
            halted: sleeveState.allocation.halted,
            allocatedUsd: sleeveState.allocatedUsd,
            deployedUsd,
            maxPositionUsd: sleeveState.maxPositionUsd,
            maxLeverage: sleeveState.def.limits.maxLeverage,
            maxConcurrentPositions: sleeveState.def.limits.maxConcurrentPositions,
            // Logical positions, not legs — a carry is one trade held as two.
            openPositions: countLogicalPositions(sleevePositions),
            minimumViableUsd: sleeveState.minimumViableUsd,
          }
        : undefined,
      netEdgeBps: opp.netBps,
      minNetEdgeBps: config.minNetEdgeBps,
      intendedNotionalUsd: notionalUsd,
      // A carry needs BOTH legs to clear their own minimum; on Binance the
      // perp leg at $50 binds, not the $5 spot minimum.
      venueMinNotionalUsd: bindingMinNotional([
        { venue: opp.route.split(" ")[0], market: "spot" },
        { venue: opp.route.split(" ")[0], market: "perp" },
      ]),
      minNotionalDragBps: opp.dragBps,
      breakevenDays: opp.breakevenDays ?? Infinity,
      expectedHoldDays: config.expectedHoldDays,
      navUsd: config.navUsd,
      freeBalanceUsd: Math.max(config.navUsd - deployedUsd, 0),
      capitalRequiredUsd: opp.capitalRequiredUsd,
      openPositions: countLogicalPositions(marked),
      riskTierDeployedUsd: deployedUsd,
      leverage: config.perpLeverage,
      maxLeverage: config.maxLeverage,
      venueHealthy: true,
      dataAgeSeconds: ctx.dataAgeSeconds,
      maxDataAgeSeconds: config.maxDataAgeSeconds,
      globalHalt: ctx.halted,
      dailyLossLimitHit: false,
    };

    // Evaluated as live with `paperMode` set. That exempts exactly the two
    // capital-allocation gates (tier lock and the tier's risk budget) and
    // nothing else — sleeve limits, economics, halt and staleness all apply
    // identically, because paper is only evidence if it is gated like live.
    const decision = evaluateGate({
      ...gateInput,
      strategyMode: "live",
      paperMode: true,
    });

    if (!decision.allowed) {
      decisions.push({
        opportunityId: opp.id,
        asset: opp.asset,
        strategy: opp.strategy,
        sleeveId,
        executed: false,
        rejectionCode: decision.code,
        detail: decision.detail,
        orders: [],
        fills: [],
        predictedNetBps: opp.netBps,
        predictedEntryCostBps: predictedEntryCost(opp),
        realisedEntryCostBps: null,
      });
      continue;
    }

    const legs = planLegs(opp, decision.sizedNotionalUsd, prices);
    if (!legs) {
      decisions.push({
        opportunityId: opp.id,
        asset: opp.asset,
        strategy: opp.strategy,
        sleeveId,
        executed: false,
        rejectionCode: "no_position_plan",
        detail: `Cannot derive legs for ${opp.strategy} route "${opp.route}"`,
        orders: [],
        fills: [],
        predictedNetBps: opp.netBps,
        predictedEntryCostBps: predictedEntryCost(opp),
        realisedEntryCostBps: null,
      });
      continue;
    }

    const price = prices.get(opp.asset)!;
    const qty = decision.sizedNotionalUsd / price;

    const legOrders: Order[] = [];
    const legFills: Fill[] = [];
    let failure: string | null = null;

    for (const leg of legs) {
      const intent: OrderIntent = {
        id: newIntentId(),
        ts: Date.now(),
        venue: leg.venue,
        asset: opp.asset,
        market: leg.market,
        side: leg.side,
        qty,
        type: "market",
        timeInForce: "IOC",
        sleeveId,
        strategy: opp.strategy,
        rationale: `${opp.strategyName}: ${opp.netBps.toFixed(1)}bp net over ${config.expectedHoldDays}d`,
      };

      const res = await venue.submit(intent);
      if (!res.ok) {
        failure = res.reason;
        break;
      }
      legOrders.push(res.order);
      legFills.push(...res.fills);
    }

    // A multi-leg position that only half-filled is not the position we wanted
    // — a carry with the spot leg missing is a naked short. Unwinding what did
    // fill is the correct response, and here it is safe because the venue is
    // simulated. Against a live venue this is the hardest part of the OMS and
    // gets its own treatment.
    if (failure) {
      for (const f of legFills) {
        await venue.submit({
          id: newIntentId(),
          ts: Date.now(),
          venue: f.venue,
          asset: f.asset,
          market: f.market,
          side: f.side === "buy" ? "sell" : "buy",
          qty: f.qty,
          type: "market",
          timeInForce: "IOC",
          sleeveId,
          strategy: opp.strategy,
          rationale: "Unwinding a partially-filled multi-leg entry",
          reduceOnly: true,
        });
      }

      decisions.push({
        opportunityId: opp.id,
        asset: opp.asset,
        strategy: opp.strategy,
        sleeveId,
        executed: false,
        rejectionCode: "venue_rejected",
        detail: `${failure} — unwound ${legFills.length} filled leg(s)`,
        orders: legOrders,
        fills: [],
        predictedNetBps: opp.netBps,
        predictedEntryCostBps: predictedEntryCost(opp),
        realisedEntryCostBps: null,
      });
      continue;
    }

    // What the entry actually cost.
    //
    // The denominator is the SUMMED notional across every leg, matching
    // `executionCost` in the cost model exactly. Using one leg's notional here
    // — the more intuitive choice for a carry — would overstate realised cost
    // by the number of legs and show up as a fake model error, which is
    // precisely the self-inflicted divergence this diagnostic exists to rule
    // out.
    const midFor = new Map(legOrders.map((o) => [o.id, o.referenceMid]));
    const totalNotional = legFills.reduce((a, f) => {
      const mid = midFor.get(f.orderId) ?? price;
      return a + f.qty * mid;
    }, 0);
    const totalCostUsd = legFills.reduce((a, f) => {
      // Measured against the mid this leg was priced from. Using last-traded
      // price instead would fold the last/mid gap into slippage.
      const mid = midFor.get(f.orderId) ?? price;
      const slip = Math.abs(f.price - mid) * f.qty;
      return a + f.feeUsd + slip;
    }, 0);
    const realisedEntryCostBps =
      totalNotional > 0 ? (totalCostUsd / totalNotional) * 10_000 : null;

    fills.push(...legFills);
    newFills.push(...legFills);

    decisions.push({
      opportunityId: opp.id,
      asset: opp.asset,
      strategy: opp.strategy,
      sleeveId,
      executed: true,
      rejectionCode: null,
      detail: null,
      orders: legOrders,
      fills: legFills,
      predictedNetBps: opp.netBps,
      predictedEntryCostBps: predictedEntryCost(opp),
      realisedEntryCostBps,
    });
  }

  return {
    ts: Date.now(),
    decisions,
    executed: decisions.filter((d) => d.executed).length,
    rejected: decisions.filter((d) => !d.executed).length,
    fills: newFills,
  };
}

/**
 * Compare PREDICTED entry cost against REALISED entry cost.
 *
 * DESIGN.md §8.3 calls this the key diagnostic, and it is — but only if the two
 * sides are the same quantity. Comparing realised cost against predicted *net
 * edge* would be comparing a cost to a profit and the resulting number would be
 * noise dressed as a metric.
 *
 * A persistent positive error means the cost model is optimistic: entries cost
 * more than it thinks, so every threshold derived from it is too loose.
 */
export function edgeAccuracy(decisions: PaperDecision[]): {
  strategy: string;
  samples: number;
  meanPredictedNetBps: number;
  meanPredictedCostBps: number;
  meanRealisedCostBps: number;
  /** Realised cost minus predicted cost. Positive is the direction that hurts. */
  meanErrorBps: number;
}[] {
  const byStrategy = new Map<string, PaperDecision[]>();
  for (const d of decisions) {
    if (!d.executed || d.realisedEntryCostBps === null) continue;
    const list = byStrategy.get(d.strategy);
    if (list) list.push(d);
    else byStrategy.set(d.strategy, [d]);
  }

  return [...byStrategy.entries()].map(([strategy, ds]) => {
    const mean = (pick: (d: PaperDecision) => number) =>
      ds.reduce((a, d) => a + pick(d), 0) / ds.length;

    const meanPredictedCostBps = mean((d) => d.predictedEntryCostBps);
    const meanRealisedCostBps = mean((d) => d.realisedEntryCostBps ?? 0);

    return {
      strategy,
      samples: ds.length,
      meanPredictedNetBps: mean((d) => d.predictedNetBps),
      meanPredictedCostBps,
      meanRealisedCostBps,
      meanErrorBps: meanRealisedCostBps - meanPredictedCostBps,
    };
  });
}

export type { MarkedPosition };
