/**
 * Portfolios — the risk-profile layer above sleeves (GOVERNANCE.md §1).
 *
 * The operator's charter: the system is a collection of independent
 * portfolios, each with its own objective, capital cap, drawdown limit and
 * halt state. Sleeves remain the strategy-level books; a portfolio is the
 * governance grouping over them — Conservative holds the market-neutral
 * income sleeves, Aggressive holds directional risk, Experimental holds
 * whatever is still earning its evidence.
 *
 * Isolation is the point: a portfolio breaching its drawdown halts ITS
 * member sleeves only, through the same risk machinery that already halts
 * individual sleeves. One portfolio's failure cannot cascade.
 */

export type PortfolioId = "conservative" | "aggressive" | "experimental";

export type PortfolioDef = {
  id: PortfolioId;
  name: string;
  objective: string;
  /** Sleeves governed by this portfolio's limits. */
  sleeves: string[];
  /** Charter cap on the share of NAV this portfolio may hold. */
  maxShareOfNav: number;
  /** Drawdown from the portfolio's high-water mark that halts its sleeves. */
  maxDrawdownPct: number;
};

export const PORTFOLIOS: PortfolioDef[] = [
  {
    id: "conservative",
    name: "Conservative",
    objective:
      "Capital preservation and consistent market-neutral income — funding and FX carry.",
    sleeves: ["core", "fx-carry"],
    maxShareOfNav: 0.85,
    // Tight: these books are delta-neutral, so a real drawdown means a
    // hedge slipped or costs ran away — stop early and look.
    maxDrawdownPct: 0.06,
  },
  {
    id: "aggressive",
    name: "Aggressive",
    objective:
      "Directional return with defined invalidation — trend following with mechanical stops.",
    sleeves: ["systematic"],
    maxShareOfNav: 0.25,
    maxDrawdownPct: 0.15,
  },
  {
    id: "experimental",
    name: "Experimental",
    objective:
      "Small capital validating unproven ideas before promotion. Losses here are tuition, capped.",
    sleeves: ["accumulation", "opportunistic", "fx-trend"],
    maxShareOfNav: 0.1,
    maxDrawdownPct: 0.1,
  },
];

export function portfolioOfSleeve(sleeveId: string): PortfolioDef | undefined {
  return PORTFOLIOS.find((p) => p.sleeves.includes(sleeveId));
}

/**
 * Check allocations against the charter caps (GOVERNANCE.md §2).
 *
 * Pure: takes the proposed allocations and NAV, returns any cap breaches.
 * Called on config save so an over-cap allocation is refused with the
 * charter line that refused it, not silently accepted.
 */
export function charterViolations(
  allocations: { sleeveId: string; allocatedUsd: number; enabled: boolean }[],
  navUsd: number,
): { portfolio: PortfolioId; allocatedUsd: number; capUsd: number }[] {
  if (navUsd <= 0) return [];
  const out: { portfolio: PortfolioId; allocatedUsd: number; capUsd: number }[] = [];
  for (const p of PORTFOLIOS) {
    const allocated = allocations
      .filter((a) => a.enabled && p.sleeves.includes(a.sleeveId))
      .reduce((s, a) => s + Math.max(a.allocatedUsd, 0), 0);
    const capUsd = navUsd * p.maxShareOfNav;
    if (allocated > capUsd) out.push({ portfolio: p.id, allocatedUsd: allocated, capUsd });
  }
  return out;
}
