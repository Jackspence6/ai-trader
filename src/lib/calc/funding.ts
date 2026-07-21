/**
 * Funding-rate carry — the core strategy (DESIGN.md §5, L1).
 *
 * The trade: buy spot, short the perpetual future on the same asset in the same
 * size. Directional exposure cancels, so the position is delta-neutral. When
 * funding is positive, longs pay shorts every funding interval, and we hold the
 * short. We are paid to warehouse the risk that perp longs don't want to.
 *
 * Why this is the right first strategy at our size:
 *   - It needs no latency edge. Funding is set on an 8-hour clock; being 20ms
 *     late costs nothing. DESIGN.md §0 explains why every latency-sensitive
 *     strategy is unavailable to us.
 *   - It is low-turnover. A position held for weeks amortises its entry cost to
 *     near zero, which is the only way to win when round-trip costs are ~20bp.
 *   - Its risks are legible and bounded: funding flipping negative, and perp
 *     margin management. Both are monitorable and neither is a tail event.
 *
 * The honest expectation is 8–20% APR, and this module exists largely to prove
 * that number to ourselves before any capital is at risk.
 */

import { BPS, type CostBreakdown } from "./costs";

export const HOURS_PER_YEAR = 24 * 365;

/**
 * Convert a per-interval funding rate into an annualised percentage.
 *
 * Venues quote funding as a fraction paid per interval (Binance/Bybit: 8h,
 * Hyperliquid: 1h). Comparing raw rates across venues without normalising is a
 * factor-of-eight error, and it is a mistake that looks like free money.
 */
export function annualiseFunding(ratePerInterval: number, intervalHours: number): number {
  if (intervalHours <= 0) return 0;
  return ratePerInterval * (HOURS_PER_YEAR / intervalHours);
}

/** Inverse: the per-interval rate implied by an annualised figure. */
export function deannualiseFunding(annualRate: number, intervalHours: number): number {
  if (intervalHours <= 0) return 0;
  return annualRate / (HOURS_PER_YEAR / intervalHours);
}

export type CarryInputs = {
  /** Funding rate per interval, as a fraction (0.0001 = 0.01%). */
  fundingRate: number;
  /** Funding interval in hours — 8 on Binance/Bybit, 1 on Hyperliquid. */
  intervalHours: number;
  /** Notional of ONE leg in USD. Spot and perp legs are equal by construction. */
  legNotionalUsd: number;
  /**
   * Leverage on the perp leg. Capital committed is the spot leg in full plus
   * margin for the short: notional × (1 + 1/leverage).
   */
  perpLeverage: number;
  /** Round-trip execution cost across both legs. */
  cost: CostBreakdown;
  /** Expected holding period in days, used to amortise the round-trip cost. */
  expectedHoldDays: number;
  /** Venue maintenance-margin requirement as a fraction (e.g. 0.005 = 0.5%). */
  maintenanceMargin?: number;
};

export type CarryResult = {
  /** Gross funding yield, annualised, as a fraction of leg notional. */
  grossApr: number;
  /**
   * Net APR on *capital deployed* after amortised costs. This is the number
   * that matters and the one the dashboard leads with.
   */
  netApr: number;
  /** Return on capital ignoring costs — isolates the leverage contribution. */
  grossAprOnCapital: number;
  /** Total capital required: spot leg + perp margin. */
  capitalRequiredUsd: number;
  /** Capital efficiency multiplier from leverage: L/(L+1). */
  capitalEfficiency: number;
  /** Days of funding needed to pay back the round-trip cost. */
  breakevenDays: number;
  /** Funding income per interval, in USD. */
  incomePerIntervalUsd: number;
  /** Funding income per day, in USD. */
  incomePerDayUsd: number;
  /** Expected profit in USD over the full expected hold. */
  expectedProfitUsd: number;
  /**
   * How far the perp price can move against the short before liquidation, as a
   * fraction. Delta-neutrality protects PnL, not margin — the spot leg's gain
   * is in a different account until we move it.
   */
  liquidationDistance: number;
  /** Net edge in bps over the whole hold, for comparison with other signals. */
  netEdgeBps: number;
};

/**
 * Evaluate a funding-carry opportunity end to end.
 *
 * The two subtleties worth reading the code for:
 *
 * 1. **Capital efficiency.** The naive view is that $1,000 of carry needs
 *    $2,000 (long spot + short perp). It doesn't: the short only needs margin.
 *    At leverage L the capital is notional × (1 + 1/L), so return on capital is
 *    multiplied by L/(L+1) — 3x leverage recovers 75% of the headline APR,
 *    5x recovers 83%. Raising leverage past that point buys very little extra
 *    yield while moving liquidation much closer, which is a bad trade.
 *
 * 2. **Cost amortisation.** Round-trip cost is paid once; funding accrues
 *    continuously. So the same opportunity is unattractive held for a day and
 *    attractive held for a month. `breakevenDays` makes that explicit, and the
 *    entry gate refuses positions whose breakeven exceeds their expected hold.
 */
export function evaluateCarry(inp: CarryInputs): CarryResult {
  const {
    fundingRate,
    intervalHours,
    legNotionalUsd,
    perpLeverage,
    cost,
    expectedHoldDays,
    maintenanceMargin = 0.005,
  } = inp;

  const leverage = Math.max(perpLeverage, 1);
  const grossApr = annualiseFunding(fundingRate, intervalHours);

  const capitalEfficiency = leverage / (leverage + 1);
  const capitalRequiredUsd = legNotionalUsd * (1 + 1 / leverage);
  const grossAprOnCapital = grossApr * capitalEfficiency;

  const intervalsPerDay = intervalHours > 0 ? 24 / intervalHours : 0;
  const incomePerIntervalUsd = fundingRate * legNotionalUsd;
  const incomePerDayUsd = incomePerIntervalUsd * intervalsPerDay;

  // Round-trip cost as a fraction of one leg's notional. `cost.totalUsd` is
  // already the absolute cost across both legs, both directions.
  const roundTripFraction =
    legNotionalUsd > 0 ? cost.totalUsd / legNotionalUsd : 0;

  const dailyGross = grossApr / 365;
  const breakevenDays =
    dailyGross > 0 ? roundTripFraction / dailyGross : Infinity;

  const hold = Math.max(expectedHoldDays, 1 / 24);
  const amortisedCostApr = roundTripFraction * (365 / hold);

  // Net APR is quoted on capital deployed, so the cost is scaled by the same
  // efficiency factor as the income — otherwise leverage would appear to
  // magically reduce costs.
  const netApr = grossAprOnCapital - amortisedCostApr * capitalEfficiency;

  const expectedProfitUsd = incomePerDayUsd * hold - cost.totalUsd;

  // Isolated short: liquidation when the adverse move consumes margin down to
  // the maintenance requirement.
  const liquidationDistance = Math.max(1 / leverage - maintenanceMargin, 0);

  const netEdgeBps =
    legNotionalUsd > 0 ? (expectedProfitUsd / legNotionalUsd) * BPS : 0;

  return {
    grossApr,
    netApr,
    grossAprOnCapital,
    capitalRequiredUsd,
    capitalEfficiency,
    breakevenDays,
    incomePerIntervalUsd,
    incomePerDayUsd,
    expectedProfitUsd,
    liquidationDistance,
    netEdgeBps,
  };
}

/**
 * Cross-venue funding spread (DESIGN.md §5, L2).
 *
 * Short the perp where funding is most positive, long the perp where it is
 * least (or negative). Delta-neutral without needing a spot leg at all, and the
 * *difference* is frequently wider than either leg on its own — which is why
 * this outranks single-venue carry once we have margin on two venues.
 *
 * The cost is real though: margin on both venues means capital is split, and
 * both legs are perps so both carry liquidation risk in opposite directions.
 */
export type FundingSpreadInputs = {
  shortVenue: string;
  longVenue: string;
  /** Annualised funding on the venue we short (we receive this). */
  shortAnnualRate: number;
  /** Annualised funding on the venue we long (we pay this). */
  longAnnualRate: number;
  legNotionalUsd: number;
  perpLeverage: number;
  cost: CostBreakdown;
  expectedHoldDays: number;
};

export type FundingSpreadResult = {
  spreadApr: number;
  netApr: number;
  capitalRequiredUsd: number;
  breakevenDays: number;
  expectedProfitUsd: number;
  netEdgeBps: number;
};

export function evaluateFundingSpread(
  inp: FundingSpreadInputs,
): FundingSpreadResult {
  const leverage = Math.max(inp.perpLeverage, 1);
  const spreadApr = inp.shortAnnualRate - inp.longAnnualRate;

  // Both legs are perps, so both need margin — capital is 2 × notional/L.
  const capitalRequiredUsd = (inp.legNotionalUsd * 2) / leverage;

  const roundTripFraction =
    inp.legNotionalUsd > 0 ? inp.cost.totalUsd / inp.legNotionalUsd : 0;
  const dailySpread = spreadApr / 365;
  const breakevenDays =
    dailySpread > 0 ? roundTripFraction / dailySpread : Infinity;

  const hold = Math.max(inp.expectedHoldDays, 1 / 24);
  const incomeUsd = inp.legNotionalUsd * dailySpread * hold;
  const expectedProfitUsd = incomeUsd - inp.cost.totalUsd;

  const netAprOnNotional = spreadApr - roundTripFraction * (365 / hold);
  const netApr =
    capitalRequiredUsd > 0
      ? (netAprOnNotional * inp.legNotionalUsd) / capitalRequiredUsd
      : 0;

  return {
    spreadApr,
    netApr,
    capitalRequiredUsd,
    breakevenDays,
    expectedProfitUsd,
    netEdgeBps:
      inp.legNotionalUsd > 0
        ? (expectedProfitUsd / inp.legNotionalUsd) * BPS
        : 0,
  };
}

/**
 * Funding-regime classification from a history of annualised rates.
 *
 * Entry timing on carry is mostly about *persistence*, not level. A single
 * 40% APR print is often a liquidation artefact that mean-reverts within one
 * interval; a steady 12% for three weeks is a regime. So we score on the median
 * rather than the latest value, and separately report how stable the series is.
 */
export type FundingRegime = {
  /** Median annualised rate over the window — robust to single-print spikes. */
  medianApr: number;
  latestApr: number;
  /** Fraction of intervals in the window where funding was positive. */
  positiveShare: number;
  /** Standard deviation of the annualised rate — regime stability. */
  volatilityApr: number;
  /** Percentile of the latest reading within the window, 0–1. */
  percentile: number;
  label: "rich" | "normal" | "thin" | "inverted";
};

export function classifyFundingRegime(annualisedHistory: number[]): FundingRegime | null {
  if (annualisedHistory.length === 0) return null;

  const sorted = [...annualisedHistory].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianApr =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const latestApr = annualisedHistory[annualisedHistory.length - 1];
  const positiveShare =
    annualisedHistory.filter((r) => r > 0).length / annualisedHistory.length;

  const m = annualisedHistory.reduce((a, b) => a + b, 0) / annualisedHistory.length;
  const volatilityApr =
    annualisedHistory.length < 2
      ? 0
      : Math.sqrt(
          annualisedHistory.reduce((a, r) => a + (r - m) ** 2, 0) /
            (annualisedHistory.length - 1),
        );

  const below = annualisedHistory.filter((r) => r < latestApr).length;
  const percentile = below / annualisedHistory.length;

  // Thresholds are in annualised terms and deliberately conservative: "rich"
  // starts at 15% because that is roughly where carry clears its costs with
  // enough margin to survive a partial decay before we can exit.
  const label: FundingRegime["label"] =
    medianApr < 0
      ? "inverted"
      : medianApr >= 0.15
        ? "rich"
        : medianApr >= 0.05
          ? "normal"
          : "thin";

  return { medianApr, latestApr, positiveShare, volatilityApr, percentile, label };
}
