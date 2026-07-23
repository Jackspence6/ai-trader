/**
 * Risk-limit enforcement — making the limits real.
 *
 * The sleeves and the fund carry drawdown and daily-loss limits, and the UI
 * shows them prominently. Until now nothing acted on them: `dailyLossLimitHit`
 * was hard-coded false and no sleeve was ever halted. A system that displays a
 * limit it does not enforce is worse than one with no limit, because it looks
 * safe while being exactly as exposed — the same lie the rest of this codebase
 * refuses everywhere else.
 *
 * This closes that gap. Every pass, the current book is measured against its
 * limits and:
 *
 *   - a **fund-level** breach (drawdown from the high-water mark, or loss on the
 *     day) trips the global kill switch — everything stops;
 *   - a **sleeve-level** drawdown breach halts *that sleeve only*, which is the
 *     blast-radius isolation the design promises: the neutral book keeps earning
 *     while the offending book sits out.
 *
 * Halts are one-way here. Recovering past the limit does not un-halt — a breach
 * is a decision to review, not a threshold that clears itself, so resuming is a
 * deliberate operator action (the Risk screen). This function only ever *adds*
 * halts; it never clears one.
 *
 * High-water marks are seeded from the current value on first sight, so a fresh
 * book starts at zero drawdown and cannot false-trip on its opening balance.
 */

import { PORTFOLIOS } from "@/lib/portfolio/portfolios";

export type RiskState = {
  /** Portfolio high-water marks, by portfolio id (GOVERNANCE.md §1). */
  portfolioHwmUsd?: Record<string, number>;
  /** Fund NAV high-water mark. */
  fundHwmUsd: number;
  /** UTC day the daily baseline belongs to, e.g. "2026-07-22". */
  dayKey: string;
  /** Fund NAV at the start of `dayKey`. */
  dayStartUsd: number;
  /** Per-sleeve equity high-water mark. */
  sleeveHwmUsd: Record<string, number>;
};

export type RiskBreach = {
  scope: "fund" | "sleeve" | "portfolio";
  id?: string;
  kind: "drawdown" | "daily_loss" | "charter_cap";
  /** The observed decline, as a fraction. */
  observed: number;
  /** The limit it exceeded, as a fraction. */
  limit: number;
  detail: string;
};

export type SleeveRisk = {
  id: string;
  name: string;
  /** Allocated capital plus this sleeve's P&L — its live equity. */
  equityUsd: number;
  maxDrawdownPct: number;
  alreadyHalted: boolean;
};

export type RiskInput = {
  navUsd: number;
  /** Current UTC day key, injected so the function stays pure. */
  dayKey: string;
  fund: { dailyLossPct: number; maxDrawdownPct: number };
  sleeves: SleeveRisk[];
  prev: RiskState | null;
};

export type RiskEvaluation = {
  state: RiskState;
  /** Set when the fund breached — trip the global halt with this reason. */
  fundBreach: RiskBreach | null;
  /** Sleeves to halt this pass (breached and not already halted). */
  sleeveHalts: { id: string; name: string; breach: RiskBreach }[];
  /** Everything observed, halted or not, for reporting. */
  breaches: RiskBreach[];
  /** Current fund drawdown and day P&L, for display even when not breached. */
  fundDrawdown: number;
  fundDayLoss: number;
};

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function evaluateRisk(input: RiskInput): RiskEvaluation {
  const { navUsd, dayKey, fund, sleeves, prev } = input;

  const fundHwmUsd = Math.max(prev?.fundHwmUsd ?? navUsd, navUsd);
  // A new UTC day resets the daily baseline to the current NAV.
  const sameDay = prev?.dayKey === dayKey;
  const dayStartUsd = sameDay ? (prev?.dayStartUsd ?? navUsd) : navUsd;

  const fundDrawdown = fundHwmUsd > 0 ? (fundHwmUsd - navUsd) / fundHwmUsd : 0;
  const fundDayLoss = dayStartUsd > 0 ? (dayStartUsd - navUsd) / dayStartUsd : 0;

  const breaches: RiskBreach[] = [];
  let fundBreach: RiskBreach | null = null;

  if (fundDrawdown > fund.maxDrawdownPct) {
    fundBreach = {
      scope: "fund",
      kind: "drawdown",
      observed: fundDrawdown,
      limit: fund.maxDrawdownPct,
      detail: `Fund drawdown ${pct(fundDrawdown)} exceeds the ${pct(fund.maxDrawdownPct)} limit`,
    };
    breaches.push(fundBreach);
  }
  if (fundDayLoss > fund.dailyLossPct) {
    const b: RiskBreach = {
      scope: "fund",
      kind: "daily_loss",
      observed: fundDayLoss,
      limit: fund.dailyLossPct,
      detail: `Fund down ${pct(fundDayLoss)} on the day, past the ${pct(fund.dailyLossPct)} limit`,
    };
    breaches.push(b);
    // Prefer the drawdown reason if both fired; otherwise this is the trigger.
    if (!fundBreach) fundBreach = b;
  }

  const sleeveHwmUsd: Record<string, number> = { ...(prev?.sleeveHwmUsd ?? {}) };
  const sleeveHalts: { id: string; name: string; breach: RiskBreach }[] = [];

  for (const s of sleeves) {
    const hwm = Math.max(sleeveHwmUsd[s.id] ?? s.equityUsd, s.equityUsd);
    sleeveHwmUsd[s.id] = hwm;
    const dd = hwm > 0 ? (hwm - s.equityUsd) / hwm : 0;
    if (dd > s.maxDrawdownPct) {
      const b: RiskBreach = {
        scope: "sleeve",
        id: s.id,
        kind: "drawdown",
        observed: dd,
        limit: s.maxDrawdownPct,
        detail: `${s.name} drawdown ${pct(dd)} exceeds its ${pct(s.maxDrawdownPct)} limit`,
      };
      breaches.push(b);
      // Only act on a sleeve not already sitting halted.
      if (!s.alreadyHalted) sleeveHalts.push({ id: s.id, name: s.name, breach: b });
    }
  }

  // --- portfolio layer: aggregate member sleeves, own HWM, own halt --------
  // A portfolio breaching its charter drawdown halts its member sleeves ONLY
  // (GOVERNANCE.md §1). Enforced with the same high-water pattern as the fund
  // and sleeves — one machine, three altitudes.
  const portfolioHwmUsd: Record<string, number> = { ...(prev?.portfolioHwmUsd ?? {}) };
  for (const p of PORTFOLIOS) {
    const members = sleeves.filter((s) => p.sleeves.includes(s.id));
    if (members.length === 0) continue;
    const equity = members.reduce((a, m) => a + m.equityUsd, 0);
    const hwm = Math.max(portfolioHwmUsd[p.id] ?? equity, equity);
    portfolioHwmUsd[p.id] = hwm;
    const dd = hwm > 0 ? (hwm - equity) / hwm : 0;
    if (dd > p.maxDrawdownPct) {
      const b: RiskBreach = {
        scope: "portfolio",
        id: p.id,
        kind: "drawdown",
        observed: dd,
        limit: p.maxDrawdownPct,
        detail: `${p.name} portfolio drawdown ${pct(dd)} exceeds its ${pct(p.maxDrawdownPct)} charter limit`,
      };
      breaches.push(b);
      for (const m of members) {
        if (!m.alreadyHalted && !sleeveHalts.some((h) => h.id === m.id)) {
          sleeveHalts.push({ id: m.id, name: m.name, breach: b });
        }
      }
    }
  }

  return {
    state: { fundHwmUsd, dayKey, dayStartUsd, sleeveHwmUsd, portfolioHwmUsd },
    fundBreach,
    sleeveHalts,
    breaches,
    fundDrawdown,
    fundDayLoss,
  };
}
