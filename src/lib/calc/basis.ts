/**
 * Cash-and-carry basis — the futures version of carry (EXPANSION.md A2).
 *
 * A dated future trades away from spot: in **contango** it is priced above spot,
 * in **backwardation** below. That gap is the basis, and it is not free money
 * lying around — it converges to exactly zero at expiry, mechanically, because
 * the contract settles against spot. So the trade writes itself:
 *
 *   - Contango (future > spot): **buy spot, short the future.** The short gains
 *     as the future falls to meet spot; the spot leg is the hedge. You capture
 *     the basis with no directional exposure.
 *   - Backwardation (future < spot): the reverse — short spot, long the future.
 *
 * Why it fits this system as well as funding carry does: it is delta-neutral,
 * low-turnover, and the payoff is *deterministic at expiry* rather than
 * dependent on a funding rate staying positive. The one thing that matters is
 * annualising correctly — a 1.8% basis is nothing over three days and a great
 * trade over ninety, so everything is expressed per year, to expiry.
 */

import { BPS, type CostBreakdown } from "./costs";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type BasisInputs = {
  /** Spot price. */
  spot: number;
  /** Dated-future price. */
  future: number;
  /** Expiry timestamp (ms). */
  expiryMs: number;
  /** Now (ms) — injected so the function stays pure and testable. */
  now: number;
  /** Round-trip cost across BOTH legs, from the shared cost model. */
  cost: CostBreakdown;
  /** Notional of one leg, USD — the basis is captured on this much spot. */
  legNotionalUsd: number;
};

export type BasisDirection = "cash-and-carry" | "reverse-carry" | "none";

export type BasisResult = {
  /** future/spot − 1. Positive is contango. */
  basisPct: number;
  daysToExpiry: number;
  /** The basis annualised to expiry — comparable with a funding APR. */
  annualisedBasisApr: number;
  /** The profitable trade given the sign of the basis. */
  direction: BasisDirection;
  /** Net APR after the round-trip cost, amortised over the hold to expiry. */
  netApr: number;
  /** Net edge over the whole hold, in bps of leg notional. */
  netEdgeBps: number;
  /** Both legs are held in full (spot + future margin ≈ 1 leg each). */
  expectedProfitUsd: number;
  /** True when the net edge, after costs, is positive and worth holding. */
  viable: boolean;
};

/**
 * Evaluate a cash-and-carry basis opportunity.
 *
 * The cost is paid once to put the trade on; at expiry the legs settle against
 * each other, so the exit is close to free. The round-trip figure is therefore
 * amortised over the days to expiry, exactly like the funding-carry entry cost —
 * a basis held to a distant expiry amortises its cost to almost nothing, which
 * is the whole reason the trade works.
 */
export function evaluateBasis(inp: BasisInputs): BasisResult {
  const { spot, future, expiryMs, now, cost, legNotionalUsd } = inp;

  const daysToExpiry = Math.max((expiryMs - now) / MS_PER_DAY, 0);
  const basisPct = spot > 0 ? future / spot - 1 : 0;

  // No time left, or no spot, means no annualisable trade.
  if (daysToExpiry < 0.5 || spot <= 0) {
    return {
      basisPct,
      daysToExpiry,
      annualisedBasisApr: 0,
      direction: "none",
      netApr: 0,
      netEdgeBps: 0,
      expectedProfitUsd: 0,
      viable: false,
    };
  }

  const annualisedBasisApr = basisPct * (365 / daysToExpiry);
  const direction: BasisDirection =
    basisPct > 0 ? "cash-and-carry" : basisPct < 0 ? "reverse-carry" : "none";

  // Gross is the magnitude of the basis captured over the hold; the cost is a
  // one-off round trip amortised over the same window.
  const grossFraction = Math.abs(basisPct);
  const roundTripFraction = legNotionalUsd > 0 ? cost.totalUsd / legNotionalUsd : 0;
  const netFraction = grossFraction - roundTripFraction;

  const netApr = netFraction * (365 / daysToExpiry);
  const netEdgeBps = netFraction * BPS;
  const expectedProfitUsd = netFraction * legNotionalUsd;

  return {
    basisPct,
    daysToExpiry,
    annualisedBasisApr,
    direction: direction === "none" ? "none" : direction,
    netApr,
    netEdgeBps,
    expectedProfitUsd,
    viable: direction !== "none" && netEdgeBps > 0,
  };
}

/** Parse a Binance dated-future symbol (e.g. "BTCUSDT_250926") into its expiry. */
export function parseDeliveryExpiry(symbol: string): number | null {
  const m = symbol.match(/_(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  // Delivery is 08:00 UTC on the settlement date for Binance quarterlies.
  const ts = Date.parse(`20${yy}-${mm}-${dd}T08:00:00Z`);
  return Number.isNaN(ts) ? null : ts;
}
