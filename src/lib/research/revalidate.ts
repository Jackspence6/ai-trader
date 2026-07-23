/**
 * Automated strategy re-validation — the backtests run themselves.
 *
 * The house method is that evidence decides allocations (DESIGN.md §8,
 * GOVERNANCE.md §3). Until now the evidence was gathered when an operator
 * opened the Research page; a strategy could deteriorate for weeks between
 * looks. This module makes the check autonomous: twice a day the trading loop
 * replays every strategy through its own backtest on fresh history, grades the
 * result into a health state, and records the verdict durably — so promotion
 * and demotion reviews start from current evidence, not stale memory.
 *
 * Three design rules:
 *   - Same engines the Research page uses, same live parameters. An automated
 *     verdict that ran different code from the interactive one would be two
 *     truths.
 *   - Advisory, not autonomous: a FAILING verdict raises a loud alert, it does
 *     not move capital. Allocation changes go through the charter with a
 *     written reason (GOVERNANCE.md §2) — the machine proposes, the operator
 *     disposes.
 *   - A research failure must never fail a trading pass. Every engine runs in
 *     its own try/catch and partial results are still recorded.
 */

import { readConfig } from "@/lib/engine/store";
import { readFills } from "@/lib/oms/store";
import { sleeveForStrategy } from "@/lib/portfolio/sleeves";
import { appendLog, readJson, readLog, writeJson } from "@/lib/store/kv";
import { runCarryBacktest } from "@/lib/backtest/run";
import { runFxBacktest } from "@/lib/backtest/runfx";
import { runSpreadBacktest } from "@/lib/backtest/runspread";
import { runCryptoTrendBacktest } from "@/lib/backtest/runcryptotrend";
import type { CarryStats } from "@/lib/backtest/carry";

export const RESEARCH_LATEST_KEY = "research_latest";
export const RESEARCH_LOG = "research_verdicts";

/** Twice a day: funding history moves every 8h, FX fixes daily. */
export const REVALIDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;

export type StrategyHealth = "healthy" | "watch" | "failing";

export type VerdictRow = {
  code: string;
  name: string;
  sleeveId: string | null;
  /** Whether this strategy's sleeve is enabled with capital allocated. */
  funded: boolean;
  /**
   * Whether the sleeve exists FOR this strategy alone. In a shared sleeve
   * (core holds L1, L2 and L3) the allocation belongs to whichever member is
   * actually earning — "funded" alone would overstate an idle member's claim.
   */
  dedicated: boolean;
  /** Open positions attributed to this strategy right now. */
  openPositions: number;
  periodDays: number;
  totalReturnPct: number;
  annualisedReturnPct: number;
  sharpe: number | null;
  maxDrawdownPct: number;
  trades: number;
  winRate: number;
  health: StrategyHealth;
  reasons: string[];
  /** Annualised return now minus at the previous check; null on the first. */
  deltaAnnualisedPct: number | null;
};

export type ResearchSnapshot = {
  ts: number;
  durationMs: number;
  rows: VerdictRow[];
  alerts: string[];
  errors: string[];
};

/**
 * Grade one strategy's backtest into a health state.
 *
 * The rules are deliberately few and explainable — a verdict nobody can
 * reconstruct from the reasons list is a verdict nobody will trust:
 *   FAILING — loses after costs over the tested window.
 *   WATCH   — earns, but thinly (Sharpe < 0.3), on scant trades (< 5), or at
 *             less than half what it earned at the previous check.
 *   HEALTHY — everything else.
 */
export function classifyHealth(
  stats: Pick<CarryStats, "annualisedReturnPct" | "sharpe" | "trades">,
  prevAnnualisedPct: number | null,
): { health: StrategyHealth; reasons: string[] } {
  if (stats.annualisedReturnPct < 0) {
    return {
      health: "failing",
      reasons: ["loses money after costs over the tested window"],
    };
  }

  const reasons: string[] = [];
  if (stats.trades < 5) reasons.push("fewer than 5 trades — evidence is thin");
  if (stats.sharpe !== null && stats.sharpe < 0.3)
    reasons.push("weak risk-adjusted return (Sharpe below 0.3)");
  if (
    prevAnnualisedPct !== null &&
    prevAnnualisedPct > 0.005 &&
    stats.annualisedReturnPct < prevAnnualisedPct / 2
  )
    reasons.push("earning less than half of what it did at the previous check");

  return { health: reasons.length > 0 ? "watch" : "healthy", reasons };
}

/**
 * The alerts an operator should actually act on — capital vs evidence
 * mismatches. A failing strategy alerts only when capital is genuinely at
 * stake: it has positions open, or a sleeve exists solely to fund it. A
 * failing member idle inside a shared sleeve (L2 in core) is the designed
 * state — scored, visible, and blocked by the entry gate — so the health row
 * says FAILING but no alarm rings.
 */
export function buildAlerts(rows: VerdictRow[]): string[] {
  const alerts: string[] = [];
  for (const r of rows) {
    if (r.health === "failing" && r.openPositions > 0) {
      alerts.push(
        `${r.code} ${r.name} has ${r.openPositions} open position(s) but its latest backtest loses money after costs — review it on the Portfolios page.`,
      );
    } else if (r.health === "failing" && r.funded && r.dedicated) {
      alerts.push(
        `${r.code} ${r.name} holds live capital but its latest backtest loses money after costs — review its allocation on the Portfolios page.`,
      );
    } else if (!r.funded && r.health === "healthy" && r.annualisedReturnPct >= 0.03) {
      alerts.push(
        `${r.code} ${r.name} backtests at ${(r.annualisedReturnPct * 100).toFixed(1)}%/yr while holding no capital — candidate for a promotion review.`,
      );
    }
  }
  return alerts;
}

type SleeveAlloc = { sleeveId: string; enabled: boolean; halted: boolean; allocatedUsd: number };

function fundingStateOf(
  code: string,
  sleeves: SleeveAlloc[],
): { sleeveId: string | null; funded: boolean; dedicated: boolean } {
  const def = sleeveForStrategy(code);
  if (!def) return { sleeveId: null, funded: false, dedicated: false };
  const alloc = sleeves.find((s) => s.sleeveId === def.id);
  return {
    sleeveId: def.id,
    funded: Boolean(alloc && alloc.enabled && !alloc.halted && alloc.allocatedUsd > 0),
    dedicated: def.strategies.length === 1,
  };
}

/** Open-position count per strategy code, from the fill log's net quantities. */
export function openPositionsByStrategy(
  fills: { strategy: string; venue: string; asset: string; market: string; side: string; qty: number }[],
): Map<string, number> {
  const net = new Map<string, number>();
  for (const f of fills) {
    const key = `${f.strategy}|${f.venue}|${f.asset}|${f.market}`;
    net.set(key, (net.get(key) ?? 0) + (f.side === "buy" ? f.qty : -f.qty));
  }
  const open = new Map<string, number>();
  for (const [key, qty] of net) {
    if (Math.abs(qty) < 1e-9) continue;
    const code = key.slice(0, key.indexOf("|"));
    open.set(code, (open.get(code) ?? 0) + 1);
  }
  return open;
}

/** Run every strategy's backtest once and record the graded snapshot. */
export async function runResearchPass(now = Date.now()): Promise<ResearchSnapshot> {
  const started = Date.now();
  const config = await readConfig();
  const openByCode = openPositionsByStrategy(await readFills().catch(() => []));
  const prev = await readJson<ResearchSnapshot>(RESEARCH_LATEST_KEY);
  const prevAnn = (code: string): number | null =>
    prev?.rows.find((r) => r.code === code)?.annualisedReturnPct ?? null;

  const rows: VerdictRow[] = [];
  const errors: string[] = [];

  const push = (code: string, name: string, stats: CarryStats, periodDays: number) => {
    const { sleeveId, funded, dedicated } = fundingStateOf(code, config.sleeves);
    const before = prevAnn(code);
    const { health, reasons } = classifyHealth(stats, before);
    rows.push({
      code,
      name,
      sleeveId,
      funded,
      dedicated,
      openPositions: openByCode.get(code) ?? 0,
      periodDays,
      totalReturnPct: stats.totalReturnPct,
      annualisedReturnPct: stats.annualisedReturnPct,
      sharpe: stats.sharpe,
      maxDrawdownPct: stats.maxDrawdownPct,
      trades: stats.trades,
      winRate: stats.winRate,
      health,
      reasons,
      deltaAnnualisedPct: before !== null ? stats.annualisedReturnPct - before : null,
    });
  };

  try {
    const r = await runCarryBacktest({
      minFundingApr: config.minFundingApr,
      minPositiveShare: config.minPositiveShare,
      regimeWindow: config.fundingRegimeWindow,
      expectedHoldDays: config.expectedHoldDays,
      minNetEdgeBps: config.minNetEdgeBps,
      points: 720,
    });
    push("L1", "Crypto funding carry", r.portfolio.stats, r.periodDays);
  } catch (e) {
    errors.push(`L1: ${e instanceof Error ? e.message : "backtest failed"}`);
  }

  try {
    const r = await runFxBacktest({ days: 1100 });
    push("F1", "FX interest carry", r.carry.portfolio, r.periodDays);
    push("F2", "FX trend", r.trend.portfolio, r.periodDays);
  } catch (e) {
    errors.push(`F1/F2: ${e instanceof Error ? e.message : "backtest failed"}`);
  }

  try {
    const r = await runSpreadBacktest({
      minSpreadApr: config.minFundingApr,
      minNetEdgeBps: config.minNetEdgeBps,
      expectedHoldDays: config.expectedHoldDays,
      points: 600,
    });
    // Judge L2 at its live exit deadband — the operating point, not the best cell.
    const live = r.sweep.find((s) => s.exitSpreadApr === r.liveExitSpreadApr);
    if (live) push("L2", "Cross-venue spread", live.stats, r.periodDays);
    else errors.push("L2: live exit deadband missing from sweep");
  } catch (e) {
    errors.push(`L2: ${e instanceof Error ? e.message : "backtest failed"}`);
  }

  try {
    const r = await runCryptoTrendBacktest({ days: 1000 });
    push("H1", "Crypto trend", r.portfolio.stats, r.periodDays);
  } catch (e) {
    errors.push(`H1: ${e instanceof Error ? e.message : "backtest failed"}`);
  }

  const snapshot: ResearchSnapshot = {
    ts: now,
    durationMs: Date.now() - started,
    rows,
    alerts: buildAlerts(rows),
    errors,
  };

  await writeJson(RESEARCH_LATEST_KEY, snapshot);
  await appendLog(RESEARCH_LOG, [snapshot]);
  return snapshot;
}

/**
 * Run the research pass if it is due. Called by the trading loop after the
 * trading decisions of a pass complete, so research latency can never delay a
 * trade. Returns null when nothing was due.
 */
export async function maybeRevalidate(now = Date.now()): Promise<ResearchSnapshot | null> {
  const latest = await readJson<ResearchSnapshot>(RESEARCH_LATEST_KEY);
  if (latest && now - latest.ts < REVALIDATE_INTERVAL_MS) return null;
  return runResearchPass(now);
}

/** Latest snapshot plus recent history, for the API and UI. */
export async function readResearchState(): Promise<{
  latest: ResearchSnapshot | null;
  history: ResearchSnapshot[];
}> {
  const [latest, history] = await Promise.all([
    readJson<ResearchSnapshot>(RESEARCH_LATEST_KEY),
    readLog<ResearchSnapshot>(RESEARCH_LOG, 30),
  ]);
  return { latest, history };
}
