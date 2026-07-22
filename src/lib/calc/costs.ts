/**
 * Transaction cost model.
 *
 * This is the most important file in the calculation core. Nearly every way a
 * small crypto account loses money is a cost the operator did not model: the
 * taker fee they forgot on the exit leg, the spread they assumed away, the
 * slippage from sizing into a thin book. DESIGN.md §0 is blunt about this —
 * a whole week of triangular arbitrage nets $12–18 *because* of this file's
 * subject matter, not in spite of it.
 *
 * So the rule throughout: costs are counted pessimistically and in full, both
 * legs, both directions. If an edge survives this model it might be real. If it
 * doesn't survive here, it certainly isn't.
 *
 * Units: basis points (bps) throughout. 1 bp = 0.01% = 0.0001.
 */

export const BPS = 10_000;

export type FeeSchedule = {
  /** Fee for a resting (passive) order, in bps. Can be negative — a rebate. */
  makerBps: number;
  /** Fee for a crossing (aggressive) order, in bps. */
  takerBps: number;
};

export type VenueFees = {
  venue: string;
  spot: FeeSchedule;
  perp: FeeSchedule;
  /**
   * Smallest order the venue will accept, in USD notional.
   *
   * A CONSERVATIVE per-market default, not the truth. The real minimum is
   * per-symbol and can differ by an order of magnitude: on Binance futures BTC
   * is $50, ETH is $20 and DOGE is $5, while Binance spot BTC is $5.
   *
   * These defaults are the worst case we have observed, so an edge that clears
   * them clears the real thing too. Where live rules are available
   * (`oms/venues/symbols.ts`) they override this — but the fallback must never
   * be optimistic, because an understated minimum makes an unviable trade look
   * viable and hides the drag that actually kills it.
   */
  minNotionalUsd: { spot: number; perp: number };
  /** Typical withdrawal cost in USD for the cheapest stablecoin route. */
  cheapestTransferUsd: number;
};

/**
 * Default published fees at base (non-VIP) tier as of 2026-07.
 *
 * These are *defaults only*. The live system syncs the real tier per venue
 * (DESIGN.md §7 "fee tier sync") because trading against a stale fee assumption
 * means every edge calculation in the system is quietly wrong. Where we have no
 * synced value we deliberately use the published base tier, which is the worst
 * case — erring toward overstating cost.
 */
export const DEFAULT_VENUE_FEES: Record<string, VenueFees> = {
  binance: {
    venue: "Binance",
    spot: { makerBps: 10, takerBps: 10 },
    perp: { makerBps: 2, takerBps: 5 },
    // BTC perp is $50 on both mainnet and testnet, verified against
    // /fapi/v1/exchangeInfo. Spot BTC is $5.
    minNotionalUsd: { spot: 5, perp: 50 },
    cheapestTransferUsd: 1.0,
  },
  bybit: {
    venue: "Bybit",
    spot: { makerBps: 10, takerBps: 10 },
    perp: { makerBps: 2, takerBps: 5.5 },
    minNotionalUsd: { spot: 5, perp: 5 },
    cheapestTransferUsd: 0.5,
  },
  hyperliquid: {
    venue: "Hyperliquid",
    spot: { makerBps: 4, takerBps: 7 },
    perp: { makerBps: 1.5, takerBps: 4.5 },
    minNotionalUsd: { spot: 10, perp: 10 },
    cheapestTransferUsd: 1.0,
  },
  okx: {
    venue: "OKX",
    spot: { makerBps: 8, takerBps: 10 },
    perp: { makerBps: 2, takerBps: 5 },
    minNotionalUsd: { spot: 5, perp: 5 },
    cheapestTransferUsd: 1.0,
  },
  // Spot forex at a competitive retail/ECN broker. The visible commission is
  // small — the real cost is the bid/ask spread, which is modelled per pair in
  // the FX book, not here. Min notional reflects that brokers deal in micro
  // lots. Forex has no perp market, so the perp schedule is a placeholder that
  // is never reached (FX only ever trades `spot`).
  fx: {
    venue: "FX",
    spot: { makerBps: 0.5, takerBps: 1 },
    perp: { makerBps: 0.5, takerBps: 1 },
    minNotionalUsd: { spot: 10, perp: 10 },
    cheapestTransferUsd: 0,
  },
};

export type Liquidity = "taker" | "maker";

/**
 * The venue's minimum notional for a given market.
 *
 * Conservative by construction — see the note on `minNotionalUsd`.
 */
export function minNotionalFor(fees: VenueFees, market: "spot" | "perp"): number {
  return market === "spot" ? fees.minNotionalUsd.spot : fees.minNotionalUsd.perp;
}

/**
 * The binding minimum across every leg of a multi-leg trade.
 *
 * A funding carry is only viable if BOTH legs clear their own minimum, so the
 * constraint is the largest of them. Using the smaller — or a single
 * venue-level figure — makes a trade look viable when one leg would be
 * rejected, and a half-filled carry is a naked position.
 */
export function bindingMinNotional(
  legs: { venue: string; market: "spot" | "perp" }[],
  feeTable: Record<string, VenueFees> = DEFAULT_VENUE_FEES,
): number {
  let worst = 0;
  for (const leg of legs) {
    const fees = feeTable[leg.venue.toLowerCase()] ?? worstCaseFees(feeTable);
    worst = Math.max(worst, minNotionalFor(fees, leg.market));
  }
  return worst;
}

/** Fee in bps for one leg on one venue. */
export function legFeeBps(
  fees: VenueFees,
  market: "spot" | "perp",
  liquidity: Liquidity,
): number {
  const s = market === "spot" ? fees.spot : fees.perp;
  return liquidity === "maker" ? s.makerBps : s.takerBps;
}

/**
 * Half-spread cost in bps.
 *
 * A taker pays half the quoted spread relative to mid, on top of the fee. This
 * is a real cost that gets omitted constantly — a "zero fee" venue with a 20bp
 * spread is more expensive than a 5bp-fee venue with a 2bp spread.
 */
export function halfSpreadBps(bid: number, ask: number): number {
  if (bid <= 0 || ask <= 0 || ask < bid) return 0;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / 2 / mid) * BPS;
}

/**
 * Market-impact slippage using a square-root model.
 *
 *   impact_bps = coefficient × spread_bps × sqrt(order_notional / depth_notional)
 *
 * The square-root form is the standard empirical result: impact scales with the
 * *square root* of participation, not linearly. We anchor it on the observed
 * spread and on real book depth rather than a fixed guess, so a thin altcoin
 * book is automatically punished relative to BTC.
 *
 * This is an approximation. The backtester (DESIGN.md §9) walks the recorded L2
 * book properly instead of using this; this model exists for the live scanner
 * where we need an estimate in microseconds, and for the dashboard's
 * pre-trade display. It is tuned to be pessimistic.
 */
export function slippageBps(
  orderNotionalUsd: number,
  depthNotionalUsd: number,
  spreadBps: number,
  coefficient = 0.6,
): number {
  if (orderNotionalUsd <= 0) return 0;
  // No depth information means we cannot claim the trade is cheap. Charge a
  // punitive estimate rather than zero — silence is not evidence of liquidity.
  if (depthNotionalUsd <= 0) return spreadBps * 5;
  const participation = orderNotionalUsd / depthNotionalUsd;
  return coefficient * Math.max(spreadBps, 1) * Math.sqrt(participation);
}

export type LegSpec = {
  venue: string;
  market: "spot" | "perp";
  liquidity: Liquidity;
  notionalUsd: number;
  /** Quoted spread on this leg, in bps. */
  spreadBps: number;
  /** Visible book depth within a few ticks, in USD. */
  depthUsd: number;
};

export type CostBreakdown = {
  feeBps: number;
  spreadBps: number;
  slippageBps: number;
  totalBps: number;
  totalUsd: number;
};

/**
 * Full cost of executing a set of legs **once** (i.e. one direction).
 *
 * Note the deliberate asymmetry: a maker order pays no half-spread (it is the
 * one quoting), but carries fill risk we account for elsewhere. A taker pays
 * the half-spread plus impact.
 */
export function executionCost(
  legs: LegSpec[],
  feeTable: Record<string, VenueFees> = DEFAULT_VENUE_FEES,
): CostBreakdown {
  let feeUsd = 0;
  let spreadUsd = 0;
  let slipUsd = 0;
  let notional = 0;

  for (const leg of legs) {
    const fees = feeTable[leg.venue.toLowerCase()];
    // An unknown venue must not silently cost nothing. Fall back to the most
    // expensive schedule we know about.
    const resolved = fees ?? worstCaseFees(feeTable);

    notional += leg.notionalUsd;
    feeUsd += (legFeeBps(resolved, leg.market, leg.liquidity) / BPS) * leg.notionalUsd;

    if (leg.liquidity === "taker") {
      spreadUsd += ((leg.spreadBps / 2) / BPS) * leg.notionalUsd;
      slipUsd +=
        (slippageBps(leg.notionalUsd, leg.depthUsd, leg.spreadBps) / BPS) *
        leg.notionalUsd;
    }
  }

  const totalUsd = feeUsd + spreadUsd + slipUsd;
  const toBps = (usd: number) => (notional === 0 ? 0 : (usd / notional) * BPS);

  return {
    feeBps: toBps(feeUsd),
    spreadBps: toBps(spreadUsd),
    slippageBps: toBps(slipUsd),
    totalBps: toBps(totalUsd),
    totalUsd,
  };
}

/** Round-trip cost: enter now, exit later on the same legs. */
export function roundTripCost(
  legs: LegSpec[],
  feeTable: Record<string, VenueFees> = DEFAULT_VENUE_FEES,
): CostBreakdown {
  const entry = executionCost(legs, feeTable);
  const exit = executionCost(legs, feeTable);
  const totalUsd = entry.totalUsd + exit.totalUsd;
  const notional = legs.reduce((a, l) => a + l.notionalUsd, 0);
  const toBps = (usd: number) => (notional === 0 ? 0 : (usd / notional) * BPS);
  return {
    feeBps: entry.feeBps + exit.feeBps,
    spreadBps: entry.spreadBps + exit.spreadBps,
    slippageBps: entry.slippageBps + exit.slippageBps,
    totalBps: toBps(totalUsd),
    totalUsd,
  };
}

function worstCaseFees(table: Record<string, VenueFees>): VenueFees {
  const all = Object.values(table);
  return all.reduce((worst, v) =>
    v.spot.takerBps > worst.spot.takerBps ? v : worst,
  );
}

/**
 * The minimum-notional drag described in DESIGN.md §7.
 *
 * Exchange minimums do not scale down with account size. On a $10 minimum order
 * a 25bp edge is 2.5 cents gross against ~2 cents of fees. This expresses that
 * arithmetic as an effective extra cost in bps: how much worse the round-trip
 * cost gets because we are forced up to the venue minimum rather than trading
 * our intended size.
 *
 * Returns 0 when the intended size already clears the minimum.
 */
export function minNotionalDragBps(
  intendedNotionalUsd: number,
  minNotionalUsd: number,
  roundTripBps: number,
): number {
  if (intendedNotionalUsd >= minNotionalUsd || intendedNotionalUsd <= 0) return 0;
  // Forced to trade `min` when we wanted `intended`: the same absolute cost is
  // spread over the smaller economic exposure we actually wanted.
  const ratio = minNotionalUsd / intendedNotionalUsd;
  return roundTripBps * (ratio - 1);
}
