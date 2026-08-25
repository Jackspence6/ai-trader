// Fee + arbitrage math — TypeScript port of backend/oddsengine/{fees,arbmath}.py.
//
// Kept in lockstep with the Python engine by scripts/check-arb-parity.mjs, which
// asserts the spec §14.1 worked examples against BOTH implementations. If you
// change one side and not the other, that check fails.

export const MIN_FEE = 0.00001;

/** Polymarket 2026 taker fee: feeRate * p * (1 - p), 5dp, min 0.00001. */
export function takerFeePerShare(p: number, feeRate: number): number {
  if (feeRate <= 0 || p <= 0 || p >= 1) return 0;
  const fee = Math.round(feeRate * p * (1 - p) * 1e5) / 1e5;
  return Math.max(fee, MIN_FEE);
}

export function effectiveBuyPrice(p: number, feeRate: number): number {
  return p + takerFeePerShare(p, feeRate);
}

/** A share pays exactly 1 collateral unit on resolution, so odds = 1 / p_eff. */
export function effectiveDecimalOdds(p: number, feeRate: number): number {
  const pEff = effectiveBuyPrice(p, feeRate);
  if (pEff <= 0) throw new Error(`invalid effective price ${pEff}`);
  return 1 / pEff;
}

/** Cost of 1 YES + 1 NO at asks. Arb iff < 1. */
export function binaryPairCost(pYes: number, pNo: number, feeRate: number): number {
  return effectiveBuyPrice(pYes, feeRate) + effectiveBuyPrice(pNo, feeRate);
}

/** Cost of 1 YES in every outcome of a COMPLETE negRisk set. Arb iff < 1. */
export function negRiskFullSetCost(yesPrices: number[], feeRate: number): number {
  return yesPrices.reduce((acc, p) => acc + effectiveBuyPrice(p, feeRate), 0);
}

export const FEE_FALLBACK_BY_CATEGORY: Record<string, number> = {
  crypto: 0.07, sports: 0.05, finance: 0.04, politics: 0.04, mentions: 0.04,
  tech: 0.04, economics: 0.05, culture: 0.05, weather: 0.05, geopolitics: 0.0,
  other: 0.05,
};

export function feeRateForCategory(category?: string | null): number {
  if (!category) return FEE_FALLBACK_BY_CATEGORY.other;
  return FEE_FALLBACK_BY_CATEGORY[category.trim().toLowerCase()] ?? FEE_FALLBACK_BY_CATEGORY.other;
}

// ------------------------------------------------------------------ arb math

export function implied(o: number): number {
  if (o <= 1) throw new Error(`decimal odds must be > 1, got ${o}`);
  return 1 / o;
}

export function inverseSum(odds: number[]): number {
  return odds.reduce((acc, o) => acc + implied(o), 0);
}

/** Arb margin as a fraction; positive iff arbitrage exists. */
export function margin(odds: number[]): number {
  return 1 - inverseSum(odds);
}

export function balancedStakes(total: number, odds: number[]): number[] {
  const s = inverseSum(odds);
  return odds.map((o) => (total * implied(o)) / s);
}

export function profitIf(stakes: number[], odds: number[], winner: number): number {
  const total = stakes.reduce((a, b) => a + b, 0);
  return stakes[winner] * odds[winner] - total;
}

export function worstCaseProfit(stakes: number[], odds: number[]): number {
  return Math.min(...odds.map((_, i) => profitIf(stakes, odds, i)));
}

export interface StakePlan {
  stakes: number[];
  total: number;
  worstProfit: number;
  roiPct: number;
  natural: boolean;
  step: number | null;
}

/** Round to natural stake values and re-verify the arb survives rounding (§14.8). */
export function naturalizeStakes(total: number, odds: number[], steps: number[] = [50, 10]): StakePlan {
  const exact = balancedStakes(total, odds);
  for (const step of steps) {
    const rounded = exact.map((s) => Math.max(step, Math.round(s / step) * step));
    for (let i = 0; i < 3; i++) {
      if (worstCaseProfit(rounded, odds) > 0) break;
      let worstIdx = 0;
      let worstVal = Infinity;
      odds.forEach((_, j) => {
        const p = profitIf(rounded, odds, j);
        if (p < worstVal) { worstVal = p; worstIdx = j; }
      });
      rounded[worstIdx] += step;
    }
    const wp = worstCaseProfit(rounded, odds);
    if (wp > 0) {
      const tot = rounded.reduce((a, b) => a + b, 0);
      return { stakes: rounded, total: tot, worstProfit: wp, roiPct: (100 * wp) / tot, natural: true, step };
    }
  }
  const tot = exact.reduce((a, b) => a + b, 0);
  const wp = worstCaseProfit(exact, odds);
  return { stakes: exact, total: tot, worstProfit: wp, roiPct: tot ? (100 * wp) / tot : 0, natural: false, step: null };
}

export interface BookLevel { price: number; size: number }

/** Collateral deployable within a slippage bound of the best ask. */
export function depthCapacityUsd(
  levels: BookLevel[], bestAsk: number, feeRate: number, slippageBps: number,
): number {
  if (!levels.length || bestAsk <= 0) return 0;
  const maxPrice = bestAsk * (1 + slippageBps / 10_000);
  return [...levels]
    .sort((a, b) => a.price - b.price)
    .filter((l) => l.price <= maxPrice)
    .reduce((acc, l) => acc + effectiveBuyPrice(l.price, feeRate) * l.size, 0);
}
