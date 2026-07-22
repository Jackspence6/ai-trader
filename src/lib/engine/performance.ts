/**
 * Performance attribution — where the money came from, and what is not working.
 *
 * A balance tells you the score. This tells you the game: which strategy earned
 * it, on which venue, in which asset, and — just as important — what the system
 * spent most of its time *refusing* to do and why.
 *
 * That last part is usually the more actionable half. A system that executes
 * nothing is not broken by default; it may be correctly refusing bad trades.
 * The only way to tell the difference is to look at which rule fired most, and
 * whether the opportunities it blocked were ones you wanted.
 *
 * Everything here is derived from two logs — the fill log and the pass log —
 * so nothing can drift from what actually happened.
 */

import { readLog } from "@/lib/store/kv";
import { readFills, readFundingPayments } from "@/lib/oms/store";
import { buildPositions, markPositions, type Fill } from "@/lib/portfolio/positions";
import {
  reconstructTrades,
  tradeStats,
  type CompletedTrade,
  type OpenTrade,
  type TradeStats,
} from "@/lib/portfolio/trades";
import { TRADE_LOG, type TradePassRecord } from "./pass";
import { REJECTION_LABELS, type RejectionCode } from "@/lib/calc/gate";

export type Attribution = {
  key: string;
  realisedUsd: number;
  unrealisedUsd: number;
  fundingUsd: number;
  feesUsd: number;
  totalUsd: number;
  trades: number;
  openPositions: number;
};

function emptyAttribution(key: string): Attribution {
  return {
    key,
    realisedUsd: 0,
    unrealisedUsd: 0,
    fundingUsd: 0,
    feesUsd: 0,
    totalUsd: 0,
    trades: 0,
    openPositions: 0,
  };
}

/**
 * Attribute P&L by a chosen dimension.
 *
 * Positions carry venue, asset and sleeve, so the same replay answers "which
 * venue is working" and "which asset is working" without a second data model.
 * Strategy comes from the fills, since a position can in principle be built by
 * more than one strategy.
 */
export function attribute(
  fills: Fill[],
  funding: Awaited<ReturnType<typeof readFundingPayments>>,
  prices: Map<string, number>,
  by: "venue" | "asset" | "sleeve" | "strategy",
): Attribution[] {
  const marked = markPositions(buildPositions(fills, funding), prices);
  const out = new Map<string, Attribution>();

  const keyOfPosition = (p: (typeof marked)[number]) =>
    by === "venue" ? String(p.venue) : by === "asset" ? p.asset : p.sleeveId;

  if (by === "strategy") {
    // Strategy lives on the fill, not the position. Fees and trade counts come
    // straight from fills; realised P&L cannot be split per strategy without
    // per-strategy position replay, so it is attributed via the position's
    // dominant strategy below.
    const strategyOfKey = new Map<string, string>();
    for (const f of fills) {
      strategyOfKey.set(`${f.sleeveId}:${f.venue}:${f.asset}:${f.market}`, f.strategy);
    }
    for (const p of marked) {
      const key = strategyOfKey.get(p.key) ?? "unknown";
      const a = out.get(key) ?? emptyAttribution(key);
      a.realisedUsd += p.realisedUsd;
      a.unrealisedUsd += p.unrealisedUsd ?? 0;
      a.fundingUsd += p.fundingUsd;
      a.feesUsd += p.feesUsd;
      if (p.qty !== 0) a.openPositions += 1;
      out.set(key, a);
    }
    for (const f of fills) {
      const a = out.get(f.strategy);
      if (a) a.trades += 1;
    }
  } else {
    for (const p of marked) {
      const key = keyOfPosition(p);
      const a = out.get(key) ?? emptyAttribution(key);
      a.realisedUsd += p.realisedUsd;
      a.unrealisedUsd += p.unrealisedUsd ?? 0;
      a.fundingUsd += p.fundingUsd;
      a.feesUsd += p.feesUsd;
      if (p.qty !== 0) a.openPositions += 1;
      out.set(key, a);
    }
    for (const f of fills) {
      const key = by === "venue" ? String(f.venue) : by === "asset" ? f.asset : f.sleeveId;
      const a = out.get(key);
      if (a) a.trades += 1;
    }
  }

  return [...out.values()]
    .map((a) => ({
      ...a,
      totalUsd: a.realisedUsd + a.unrealisedUsd + a.fundingUsd - a.feesUsd,
    }))
    .sort((x, y) => y.totalUsd - x.totalUsd);
}

export type BlockerSummary = {
  code: string;
  label: string;
  count: number;
  share: number;
};

/**
 * What stopped the system trading, ranked.
 *
 * The top entry is the binding constraint — the one rule that, if it is wrong,
 * is costing you everything downstream of it. Tuning anything else first is
 * wasted effort.
 */
export function blockers(passes: TradePassRecord[]): BlockerSummary[] {
  const counts = new Map<string, number>();
  for (const p of passes) {
    for (const [code, n] of Object.entries(p.rejections)) {
      counts.set(code, (counts.get(code) ?? 0) + n);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  return [...counts.entries()]
    .map(([code, count]) => ({
      code,
      label: REJECTION_LABELS[code as RejectionCode] ?? code,
      count,
      share: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

export type CostAccuracy = {
  strategy: string;
  samples: number;
  meanPredictedCostBps: number;
  meanRealisedCostBps: number;
  meanErrorBps: number;
};

/**
 * Predicted vs realised entry cost, pooled across every pass.
 *
 * A persistent positive error means the cost model is optimistic, so every
 * threshold derived from it is too loose — and the scanner has been approving
 * trades that were never actually viable.
 */
export function costAccuracy(passes: TradePassRecord[]): CostAccuracy[] {
  const acc = new Map<string, { p: number; r: number; n: number }>();

  for (const pass of passes) {
    for (const e of pass.executions) {
      if (e.realisedEntryCostBps === null) continue;
      const cur = acc.get(e.strategy) ?? { p: 0, r: 0, n: 0 };
      cur.p += e.predictedEntryCostBps;
      cur.r += e.realisedEntryCostBps;
      cur.n += 1;
      acc.set(e.strategy, cur);
    }
  }

  return [...acc.entries()].map(([strategy, v]) => ({
    strategy,
    samples: v.n,
    meanPredictedCostBps: v.p / v.n,
    meanRealisedCostBps: v.r / v.n,
    meanErrorBps: (v.r - v.p) / v.n,
  }));
}

export type ActivitySummary = {
  passes: number;
  firstPassTs: number | null;
  lastPassTs: number | null;
  totalExecutions: number;
  totalScored: number;
  /** Passes that did nothing, with the reason. */
  skipped: Record<string, number>;
  /** NAV at the first and most recent pass, for a quick trajectory read. */
  navFirst: number | null;
  navLast: number | null;
};

export function activity(passes: TradePassRecord[]): ActivitySummary {
  const skipped: Record<string, number> = {};
  for (const p of passes) {
    if (p.skipped) skipped[p.skipped] = (skipped[p.skipped] ?? 0) + 1;
  }

  return {
    passes: passes.length,
    firstPassTs: passes[0]?.ts ?? null,
    lastPassTs: passes[passes.length - 1]?.ts ?? null,
    totalExecutions: passes.reduce((a, p) => a + p.executed, 0),
    totalScored: passes.reduce((a, p) => a + p.scored, 0),
    skipped,
    navFirst: passes[0]?.navBefore ?? null,
    navLast: passes[passes.length - 1]?.navAfter ?? null,
  };
}

/** Exits aggregated across passes, by reason — how the book has been closing. */
export function exitSummary(passes: TradePassRecord[]): {
  total: number;
  byReason: { reason: string; count: number }[];
} {
  const counts = new Map<string, number>();
  for (const p of passes) {
    for (const [reason, n] of Object.entries(p.exits ?? {})) {
      counts.set(reason, (counts.get(reason) ?? 0) + n);
    }
  }
  return {
    total: [...counts.values()].reduce((a, b) => a + b, 0),
    byReason: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export type PerformanceReport = {
  activity: ActivitySummary;
  byStrategy: Attribution[];
  byVenue: Attribution[];
  byAsset: Attribution[];
  bySleeve: Attribution[];
  blockers: BlockerSummary[];
  costAccuracy: CostAccuracy[];
  /** NAV over time, one point per pass. */
  navSeries: { ts: number; navUsd: number }[];
  /** Round-trip trades reconstructed from the fill log. */
  completedTrades: CompletedTrade[];
  openTrades: OpenTrade[];
  tradeStats: TradeStats;
  exits: ReturnType<typeof exitSummary>;
};

export async function buildReport(
  prices: Map<string, number>,
  passLimit = 500,
): Promise<PerformanceReport> {
  const [fills, funding, passes] = await Promise.all([
    readFills(),
    readFundingPayments(),
    readLog<TradePassRecord>(TRADE_LOG, passLimit),
  ]);

  const trades = reconstructTrades(fills, funding);

  return {
    activity: activity(passes),
    byStrategy: attribute(fills, funding, prices, "strategy"),
    byVenue: attribute(fills, funding, prices, "venue"),
    byAsset: attribute(fills, funding, prices, "asset"),
    bySleeve: attribute(fills, funding, prices, "sleeve"),
    blockers: blockers(passes),
    costAccuracy: costAccuracy(passes),
    navSeries: passes.map((p) => ({ ts: p.ts, navUsd: p.navAfter })),
    completedTrades: trades.completed,
    openTrades: trades.open,
    tradeStats: tradeStats(trades.completed),
    exits: exitSummary(passes),
  };
}
