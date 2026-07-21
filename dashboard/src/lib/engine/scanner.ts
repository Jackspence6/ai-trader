/**
 * The opportunity scanner.
 *
 * This is where live market data meets the calculation core. For every asset
 * and every venue combination it computes what the trade would actually earn
 * after costs, then runs the risk gate and records the outcome — taken, or
 * rejected with a specific reason.
 *
 * DESIGN.md principle 4: every decision is observable. Every opportunity this
 * produces is retained *including the rejected ones*, because "why is the
 * system not trading?" is unanswerable from PnL alone, and because rejected
 * opportunities are the evidence base that decides whether a shadow strategy
 * ever earns live capital.
 */

import {
  DEFAULT_VENUE_FEES,
  minNotionalDragBps,
  roundTripCost,
  type LegSpec,
} from "@/lib/calc/costs";
import { evaluateCarry, evaluateFundingSpread, classifyFundingRegime } from "@/lib/calc/funding";
import { evaluateGate, type RejectionCode } from "@/lib/calc/gate";
import { resolveTier, type TierId } from "@/lib/calc/tiers";
import {
  computePortfolio,
  sleeveForStrategy,
  type PortfolioState,
} from "@/lib/portfolio/sleeves";
import type { SleeveContext } from "@/lib/calc/gate";
import type { MarketSnapshot, Quote } from "@/lib/market/types";
import type { EngineConfig } from "./config";

export type StrategyCode = "L1" | "L2" | "L3";

export type ScoredOpportunity = {
  id: string;
  ts: number;
  strategy: StrategyCode;
  strategyName: string;
  asset: string;
  /** Human-readable execution route, e.g. "Binance spot ⇄ Binance perp". */
  route: string;
  riskTier: "low" | "medium" | "high";
  /** Which sleeve this opportunity would be funded from. */
  sleeveId: string;
  sleeveName: string;

  /** Gross edge before any cost, in bps over the expected hold. */
  grossBps: number;
  feesBps: number;
  spreadBps: number;
  slippageBps: number;
  dragBps: number;
  /** What is left for us after everything. The number that decides. */
  netBps: number;

  /** Annualised return on deployed capital, where meaningful. */
  netApr: number | null;
  breakevenDays: number | null;
  capitalRequiredUsd: number;
  notionalUsd: number;
  expectedProfitUsd: number;

  /** Funding context, for carry strategies. */
  fundingApr?: number;

  /**
   * Whether this opportunity actually became an order. Always false while the
   * system is in shadow.
   */
  taken: boolean;
  /**
   * Whether it would have been taken if the strategy were live — i.e. it
   * cleared every economic, sleeve and risk check.
   *
   * This is the number shadow mode exists to produce. Reporting only "in shadow
   * mode" on every row would make the feed useless for its actual purpose:
   * finding out whether the configuration would trade, and what stops it.
   */
  wouldTake: boolean;
  /** The binding constraint, evaluated as though the strategy were live. */
  rejectionCode: RejectionCode | null;
  rejectionDetail: string | null;
};

const STRATEGY_NAMES: Record<StrategyCode, string> = {
  L1: "Funding carry",
  L2: "Cross-venue funding spread",
  L3: "Stablecoin peg",
};

/** Group quotes by asset, then by venue and market kind. */
function index(quotes: Quote[]) {
  const byAsset = new Map<string, Quote[]>();
  for (const q of quotes) {
    const list = byAsset.get(q.asset);
    if (list) list.push(q);
    else byAsset.set(q.asset, [q]);
  }
  return byAsset;
}

function legFor(q: Quote, notionalUsd: number): LegSpec {
  return {
    venue: q.venue.toLowerCase(),
    market: q.kind,
    // Assume we cross the spread. Passive fills are cheaper but uncertain, and
    // an edge that only exists with guaranteed maker fills is not an edge.
    liquidity: "taker",
    notionalUsd,
    spreadBps: q.spreadBps,
    depthUsd: q.topOfBookUsd,
  };
}

/**
 * Build the gate's sleeve context for a strategy.
 *
 * Returns undefined when the strategy maps to no sleeve, which would be a
 * configuration bug rather than a normal state — the gate then applies
 * fund-level limits only rather than silently allowing an unbounded trade.
 */
function sleeveContextFor(
  strategyCode: string,
  portfolio: PortfolioState,
): SleeveContext | undefined {
  const def = sleeveForStrategy(strategyCode);
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

export type ScanContext = {
  config: EngineConfig;
  snapshot: MarketSnapshot;
  /** Historical annualised funding per `${venue}:${asset}`, for regime checks. */
  fundingHistory?: Record<string, number[]>;
  /**
   * Whether trading is halted. Read from the kill switch's own state file by
   * the caller, not from config — config can fail to parse, halt state must
   * not.
   */
  halted?: boolean;
  /** Current tier id; NAV plus hold period resolve the effective one. */
  currentTierId?: TierId;
  daysHeldAboveThreshold?: number;
};

/**
 * Run every scanner over one market snapshot.
 *
 * Results are sorted by net edge descending so the most attractive opportunity
 * — taken or not — is always at the top of the feed.
 */
export function scan(ctx: ScanContext): ScoredOpportunity[] {
  const { config, snapshot } = ctx;
  const tierState = resolveTier(
    config.navUsd,
    ctx.daysHeldAboveThreshold ?? 0,
    ctx.currentTierId ?? "T0",
  );
  const tier = tierState.current;

  const dataAgeSeconds = (Date.now() - snapshot.asOf) / 1000;
  const degradedVenues = new Set(snapshot.errors.map((e) => e.venue));

  // Size on NAV when we have capital, otherwise on the explicitly hypothetical
  // shadow size. `usingShadowSize` is surfaced in the UI so nobody mistakes a
  // scored opportunity for a fundable one.
  const notional =
    config.navUsd > 0
      ? config.navUsd * config.legNotionalPctOfNav
      : config.shadowNotionalUsd;

  // Sleeve state gates capital: each opportunity is funded from exactly one
  // sleeve, with that sleeve's own limits applied on top of the fund's.
  const portfolio = computePortfolio(config.navUsd, config.sleeves);

  const out: ScoredOpportunity[] = [];
  const byAsset = index(snapshot.quotes);

  for (const [asset, quotes] of byAsset) {
    out.push(
      ...scanCarry(asset, quotes, notional, config, tier, dataAgeSeconds, degradedVenues, ctx, portfolio),
    );
    out.push(
      ...scanFundingSpread(
        asset, quotes, notional, config, tier, dataAgeSeconds, degradedVenues, portfolio,
        ctx.halted ?? false,
      ),
    );
  }

  return out.sort((a, b) => b.netBps - a.netBps);
}

/* ------------------------------------------------- L1 · same-venue carry */

function scanCarry(
  asset: string,
  quotes: Quote[],
  notionalUsd: number,
  config: EngineConfig,
  tier: ReturnType<typeof resolveTier>["current"],
  dataAgeSeconds: number,
  degraded: Set<string>,
  ctx: ScanContext,
  portfolio: PortfolioState,
): ScoredOpportunity[] {
  const out: ScoredOpportunity[] = [];
  const sleeve = sleeveContextFor("L1", portfolio);

  const venues = [...new Set(quotes.map((q) => q.venue))];
  for (const venue of venues) {
    const spot = quotes.find((q) => q.venue === venue && q.kind === "spot");
    const perp = quotes.find((q) => q.venue === venue && q.kind === "perp");

    // Same-venue carry needs both legs on the same venue. Hyperliquid has no
    // spot book for these assets, so it simply produces no L1 opportunity —
    // which is correct, not an error.
    if (!spot || !perp) continue;
    if (perp.fundingRate === undefined || perp.fundingIntervalHours === undefined) continue;

    const cost = roundTripCost(
      [legFor(spot, notionalUsd), legFor(perp, notionalUsd)],
      DEFAULT_VENUE_FEES,
    );

    const carry = evaluateCarry({
      fundingRate: perp.fundingRate,
      intervalHours: perp.fundingIntervalHours,
      legNotionalUsd: notionalUsd,
      perpLeverage: config.perpLeverage,
      cost,
      expectedHoldDays: config.expectedHoldDays,
    });

    const venueFees = DEFAULT_VENUE_FEES[venue.toLowerCase()];
    const minNotional = venueFees?.minNotionalUsd ?? 10;
    const dragBps = minNotionalDragBps(notionalUsd, minNotional, cost.totalBps);

    // Gross funding earned over the hold, expressed in bps of leg notional.
    const grossBps =
      ((carry.incomePerDayUsd * config.expectedHoldDays) / notionalUsd) * 10_000;

    // Regime persistence filter. Without history we do not claim a regime —
    // we let the funding-APR floor do the work and note the absence.
    const history = ctx.fundingHistory?.[`${venue}:${asset}`];
    const regime = history ? classifyFundingRegime(history) : null;
    const regimeBlocked =
      regime !== null && regime.positiveShare < config.minPositiveShare;

    // Evaluated as though live so the feed reports the *binding* constraint —
    // the sleeve, the economics, the risk limit — rather than masking all of
    // them behind "in shadow mode". Nothing is executed either way: `taken` is
    // gated on shadow separately below.
    let decision = evaluateGate({
      strategyCode: "L1",
      strategyMode: "live",
      tier,
      riskTier: "low",
      sleeve,
      netEdgeBps: carry.netEdgeBps,
      minNetEdgeBps: config.minNetEdgeBps,
      intendedNotionalUsd: notionalUsd,
      venueMinNotionalUsd: minNotional,
      minNotionalDragBps: dragBps,
      breakevenDays: carry.breakevenDays,
      expectedHoldDays: config.expectedHoldDays,
      navUsd: config.navUsd,
      freeBalanceUsd: config.navUsd,
      capitalRequiredUsd: carry.capitalRequiredUsd,
      openPositions: 0,
      riskTierDeployedUsd: 0,
      leverage: config.perpLeverage,
      maxLeverage: config.maxLeverage,
      venueHealthy: !degraded.has(venue),
      dataAgeSeconds,
      maxDataAgeSeconds: config.maxDataAgeSeconds,
      globalHalt: ctx.halted ?? false,
      dailyLossLimitHit: false,
    });

    // Two strategy-specific vetoes the generic gate cannot know about.
    if (decision.allowed && (carry.grossApr < config.minFundingApr || regimeBlocked)) {
      decision = {
        allowed: false,
        code: "net_edge_below_threshold",
        detail: regimeBlocked
          ? `Funding positive only ${(regime!.positiveShare * 100).toFixed(0)}% of window, need ${(config.minPositiveShare * 100).toFixed(0)}%`
          : `Funding ${(carry.grossApr * 100).toFixed(2)}% APR below floor ${(config.minFundingApr * 100).toFixed(2)}%`,
      };
    }

    out.push({
      id: `L1-${venue}-${asset}`,
      ts: perp.ts,
      strategy: "L1",
      strategyName: STRATEGY_NAMES.L1,
      asset,
      route: `${venue} spot ⇄ ${venue} perp`,
      riskTier: "low",
      sleeveId: sleeve?.id ?? "unassigned",
      sleeveName: sleeve?.name ?? "Unassigned",
      grossBps,
      feesBps: cost.feeBps,
      spreadBps: cost.spreadBps,
      slippageBps: cost.slippageBps,
      dragBps,
      netBps: carry.netEdgeBps - dragBps,
      netApr: carry.netApr,
      breakevenDays: Number.isFinite(carry.breakevenDays) ? carry.breakevenDays : null,
      capitalRequiredUsd: carry.capitalRequiredUsd,
      notionalUsd,
      expectedProfitUsd: carry.expectedProfitUsd,
      fundingApr: carry.grossApr,
      // Live execution requires a linked account and a strategy promoted out of
      // shadow on evidence. Neither exists yet, so nothing is ever taken.
      taken: false,
      wouldTake: decision.allowed,
      rejectionCode: decision.allowed ? null : decision.code,
      rejectionDetail: decision.allowed ? null : decision.detail,
    });
  }

  return out;
}

/* ------------------------------------------ L2 · cross-venue funding spread */

function scanFundingSpread(
  asset: string,
  quotes: Quote[],
  notionalUsd: number,
  config: EngineConfig,
  tier: ReturnType<typeof resolveTier>["current"],
  dataAgeSeconds: number,
  degraded: Set<string>,
  portfolio: PortfolioState,
  halted: boolean,
): ScoredOpportunity[] {
  const sleeve = sleeveContextFor("L2", portfolio);
  const perps = quotes.filter(
    (q) => q.kind === "perp" && q.fundingApr !== undefined,
  );
  if (perps.length < 2) return [];

  // Short where funding is richest, long where it is cheapest. Only the single
  // widest pair per asset is worth reporting — the intermediate combinations
  // are strictly dominated and would just flood the feed.
  const sorted = [...perps].sort((a, b) => (b.fundingApr ?? 0) - (a.fundingApr ?? 0));
  const short = sorted[0];
  const long = sorted[sorted.length - 1];
  if (short.venue === long.venue) return [];

  const cost = roundTripCost(
    [legFor(short, notionalUsd), legFor(long, notionalUsd)],
    DEFAULT_VENUE_FEES,
  );

  const r = evaluateFundingSpread({
    shortVenue: short.venue,
    longVenue: long.venue,
    shortAnnualRate: short.fundingApr!,
    longAnnualRate: long.fundingApr!,
    legNotionalUsd: notionalUsd,
    perpLeverage: config.perpLeverage,
    cost,
    expectedHoldDays: config.expectedHoldDays,
  });

  const minNotional = Math.max(
    DEFAULT_VENUE_FEES[short.venue.toLowerCase()]?.minNotionalUsd ?? 10,
    DEFAULT_VENUE_FEES[long.venue.toLowerCase()]?.minNotionalUsd ?? 10,
  );
  const dragBps = minNotionalDragBps(notionalUsd, minNotional, cost.totalBps);

  const grossBps = ((r.spreadApr * config.expectedHoldDays) / 365) * 10_000;

  const decision = evaluateGate({
    strategyCode: "L2",
    strategyMode: "live",
    tier,
    riskTier: "low",
    sleeve,
    netEdgeBps: r.netEdgeBps,
    minNetEdgeBps: config.minNetEdgeBps,
    intendedNotionalUsd: notionalUsd,
    venueMinNotionalUsd: minNotional,
    minNotionalDragBps: dragBps,
    breakevenDays: r.breakevenDays,
    expectedHoldDays: config.expectedHoldDays,
    navUsd: config.navUsd,
    freeBalanceUsd: config.navUsd,
    capitalRequiredUsd: r.capitalRequiredUsd,
    openPositions: 0,
    riskTierDeployedUsd: 0,
    leverage: config.perpLeverage,
    maxLeverage: config.maxLeverage,
    venueHealthy: !degraded.has(short.venue) && !degraded.has(long.venue),
    dataAgeSeconds,
    maxDataAgeSeconds: config.maxDataAgeSeconds,
    globalHalt: halted,
    dailyLossLimitHit: false,
  });

  return [
    {
      id: `L2-${asset}-${short.venue}-${long.venue}`,
      ts: Math.min(short.ts, long.ts),
      strategy: "L2",
      strategyName: STRATEGY_NAMES.L2,
      asset,
      route: `Short ${short.venue} ⇄ Long ${long.venue}`,
      riskTier: "low",
      sleeveId: sleeve?.id ?? "unassigned",
      sleeveName: sleeve?.name ?? "Unassigned",
      grossBps,
      feesBps: cost.feeBps,
      spreadBps: cost.spreadBps,
      slippageBps: cost.slippageBps,
      dragBps,
      netBps: r.netEdgeBps - dragBps,
      netApr: r.netApr,
      breakevenDays: Number.isFinite(r.breakevenDays) ? r.breakevenDays : null,
      capitalRequiredUsd: r.capitalRequiredUsd,
      notionalUsd,
      expectedProfitUsd: r.expectedProfitUsd,
      fundingApr: r.spreadApr,
      taken: false,
      wouldTake: decision.allowed,
      rejectionCode: decision.allowed ? null : decision.code,
      rejectionDetail: decision.allowed ? null : decision.detail,
    },
  ];
}
