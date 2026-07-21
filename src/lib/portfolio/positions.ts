/**
 * Position and PnL accounting.
 *
 * Pure functions over a fill stream. Positions are never stored as a mutable
 * balance that gets incremented — they are *derived* by replaying fills, the
 * same way the fund's unit accounting derives ownership from capital events.
 *
 * That choice costs a little CPU and buys the property that matters: there is
 * one source of truth. A cached position that drifts from the fill log is the
 * classic way a trading system ends up confidently wrong about what it holds,
 * and it is exactly the drift DESIGN.md §3 wants reconciliation to catch.
 *
 * Conventions, stated because sign errors here are silent and expensive:
 *   - `qty` is signed. Positive is long, negative is short.
 *   - `avgEntry` is always a positive price.
 *   - Realised PnL is booked when a fill REDUCES a position, never when it
 *     opens or adds to one.
 *   - Fees are always a cost, on every fill, in both directions.
 */

import type { VenueId } from "@/lib/vault/store";

export type Side = "buy" | "sell";

export type Fill = {
  id: string;
  ts: number;
  venue: VenueId | string;
  /** Base asset, e.g. "BTC". */
  asset: string;
  market: "spot" | "perp";
  side: Side;
  /** Always positive. Direction comes from `side`. */
  qty: number;
  price: number;
  /** Absolute fee in USD. Always a cost. */
  feeUsd: number;
  /** Which sleeve funded this. */
  sleeveId: string;
  /** Which strategy produced it. */
  strategy: string;
  orderId: string;
};

/** A funding payment on a perp position. Positive means we received. */
export type FundingPayment = {
  id: string;
  ts: number;
  venue: VenueId | string;
  asset: string;
  amountUsd: number;
  sleeveId: string;
};

export type Position = {
  key: string;
  venue: VenueId | string;
  asset: string;
  market: "spot" | "perp";
  sleeveId: string;
  /** Signed: positive long, negative short. */
  qty: number;
  /** Volume-weighted average entry of the CURRENT open quantity. */
  avgEntry: number;
  /** Booked profit from reducing fills. */
  realisedUsd: number;
  /** Total fees paid on this position's fills. */
  feesUsd: number;
  /** Funding received (positive) or paid (negative). */
  fundingUsd: number;
  /** Notional at entry, absolute. */
  notionalUsd: number;
  openedAt: number;
  lastFillAt: number;
};

export type MarkedPosition = Position & {
  markPrice: number | null;
  unrealisedUsd: number | null;
  /** Realised + unrealised + funding − fees. Null when unmarkable. */
  totalPnlUsd: number | null;
  marketValueUsd: number | null;
};

function keyOf(f: { venue: string; asset: string; market: string; sleeveId: string }) {
  return `${f.sleeveId}:${f.venue}:${f.asset}:${f.market}`;
}

/**
 * Apply one fill to a position, returning the new state.
 *
 * The three cases, and why the middle one is the tricky one:
 *
 *   OPEN or ADD  — average entry is re-weighted; no PnL is booked. Buying more
 *                  of something does not make or lose money.
 *   REDUCE       — PnL is booked on the closed portion at the difference
 *                  between entry and exit. Average entry is UNCHANGED, because
 *                  the remaining quantity was bought at the same average.
 *   FLIP         — a fill larger than the position closes it and opens the
 *                  other way. PnL is booked only on the closed portion, and the
 *                  new position's entry is the fill price. Treating a flip as a
 *                  simple add is a real bug that silently corrupts both the
 *                  average entry and every subsequent PnL number.
 */
export function applyFill(position: Position | null, fill: Fill): Position {
  const signed = fill.side === "buy" ? fill.qty : -fill.qty;

  if (!position || position.qty === 0) {
    return {
      key: keyOf(fill),
      venue: fill.venue,
      asset: fill.asset,
      market: fill.market,
      sleeveId: fill.sleeveId,
      qty: signed,
      avgEntry: fill.price,
      realisedUsd: position?.realisedUsd ?? 0,
      feesUsd: (position?.feesUsd ?? 0) + fill.feeUsd,
      fundingUsd: position?.fundingUsd ?? 0,
      notionalUsd: Math.abs(signed) * fill.price,
      openedAt: position?.openedAt ?? fill.ts,
      lastFillAt: fill.ts,
    };
  }

  const sameDirection = Math.sign(signed) === Math.sign(position.qty);
  const feesUsd = position.feesUsd + fill.feeUsd;

  // --- add to the position ------------------------------------------------
  if (sameDirection) {
    const newQty = position.qty + signed;
    const avgEntry =
      (Math.abs(position.qty) * position.avgEntry + Math.abs(signed) * fill.price) /
      Math.abs(newQty);

    return {
      ...position,
      qty: newQty,
      avgEntry,
      feesUsd,
      notionalUsd: Math.abs(newQty) * avgEntry,
      lastFillAt: fill.ts,
    };
  }

  // --- reduce, close, or flip ---------------------------------------------
  const closingQty = Math.min(Math.abs(signed), Math.abs(position.qty));

  // Long: profit when exit > entry. Short: profit when entry > exit.
  const direction = position.qty > 0 ? 1 : -1;
  const realised = closingQty * (fill.price - position.avgEntry) * direction;

  const newQty = position.qty + signed;

  // Flip: the fill was larger than the position. The excess opens a new
  // position at the fill price, and the old average entry no longer applies.
  const flipped = Math.sign(newQty) !== 0 && Math.sign(newQty) !== Math.sign(position.qty);

  return {
    ...position,
    qty: newQty,
    avgEntry: flipped ? fill.price : position.avgEntry,
    realisedUsd: position.realisedUsd + realised,
    feesUsd,
    notionalUsd: Math.abs(newQty) * (flipped ? fill.price : position.avgEntry),
    lastFillAt: fill.ts,
  };
}

/**
 * Replay a fill stream into positions.
 *
 * Fills are sorted by timestamp first. Out-of-order application produces a
 * wrong average entry, and fills can arrive out of order from a venue's user
 * data stream — so this is not a theoretical concern.
 */
export function buildPositions(
  fills: Fill[],
  funding: FundingPayment[] = [],
): Position[] {
  const byKey = new Map<string, Position>();

  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    const k = keyOf(f);
    byKey.set(k, applyFill(byKey.get(k) ?? null, f));
  }

  // Funding attaches to the perp position for that venue/asset/sleeve.
  for (const p of funding) {
    const k = `${p.sleeveId}:${p.venue}:${p.asset}:perp`;
    const pos = byKey.get(k);
    if (pos) pos.fundingUsd += p.amountUsd;
  }

  return [...byKey.values()];
}

/**
 * Mark positions to market.
 *
 * A position we cannot price returns null PnL rather than zero. Zero reads as
 * "flat", which is a specific and wrong claim; null reads as "unknown", which
 * is the truth and is rendered as a dash.
 */
export function markPositions(
  positions: Position[],
  prices: Map<string, number>,
): MarkedPosition[] {
  return positions.map((p) => {
    const markPrice = prices.get(p.asset) ?? null;

    if (markPrice === null) {
      return {
        ...p,
        markPrice: null,
        unrealisedUsd: null,
        totalPnlUsd: null,
        marketValueUsd: null,
      };
    }

    const unrealisedUsd = p.qty * (markPrice - p.avgEntry);

    return {
      ...p,
      markPrice,
      unrealisedUsd,
      totalPnlUsd: p.realisedUsd + unrealisedUsd + p.fundingUsd - p.feesUsd,
      marketValueUsd: p.qty * markPrice,
    };
  });
}

export type SleevePnl = {
  sleeveId: string;
  realisedUsd: number;
  unrealisedUsd: number | null;
  fundingUsd: number;
  feesUsd: number;
  totalUsd: number | null;
  openPositions: number;
  grossExposureUsd: number | null;
  netExposureUsd: number | null;
};

/**
 * Per-sleeve PnL — what makes sleeve isolation enforceable rather than
 * theoretical.
 *
 * Until this existed, a sleeve's drawdown limit was a number with nothing
 * measuring against it.
 */
export function sleevePnl(marked: MarkedPosition[]): SleevePnl[] {
  const bySleeve = new Map<string, MarkedPosition[]>();
  for (const p of marked) {
    const list = bySleeve.get(p.sleeveId);
    if (list) list.push(p);
    else bySleeve.set(p.sleeveId, [p]);
  }

  return [...bySleeve.entries()].map(([sleeveId, ps]) => {
    const open = ps.filter((p) => p.qty !== 0);
    // One unmarkable position makes the sleeve total unknowable. Summing the
    // rest would understate it while looking precise.
    const anyUnmarked = open.some((p) => p.markPrice === null);

    const realisedUsd = ps.reduce((a, p) => a + p.realisedUsd, 0);
    const fundingUsd = ps.reduce((a, p) => a + p.fundingUsd, 0);
    const feesUsd = ps.reduce((a, p) => a + p.feesUsd, 0);
    const unrealisedUsd = anyUnmarked
      ? null
      : open.reduce((a, p) => a + (p.unrealisedUsd ?? 0), 0);

    return {
      sleeveId,
      realisedUsd,
      unrealisedUsd,
      fundingUsd,
      feesUsd,
      totalUsd:
        unrealisedUsd === null ? null : realisedUsd + unrealisedUsd + fundingUsd - feesUsd,
      openPositions: open.length,
      grossExposureUsd: anyUnmarked
        ? null
        : open.reduce((a, p) => a + Math.abs(p.marketValueUsd ?? 0), 0),
      netExposureUsd: anyUnmarked
        ? null
        : open.reduce((a, p) => a + (p.marketValueUsd ?? 0), 0),
    };
  });
}

/**
 * Count LOGICAL positions, not legs.
 *
 * A delta-neutral carry is one trade held as two legs — long spot and short
 * perp. Counting legs makes a single carry look like two positions, so a limit
 * of "1 concurrent position" permits half a carry and then blocks everything
 * forever. That is not a hypothetical: it silently froze the paper book after
 * its first trade.
 *
 * Legs are grouped by (sleeve, strategy, asset), which is the unit a strategy
 * actually reasons about when it decides to enter or exit.
 */
export function countLogicalPositions(
  positions: { qty: number; sleeveId: string; asset: string }[],
  strategyOf: (p: { sleeveId: string; asset: string }) => string = () => "",
): number {
  const groups = new Set<string>();
  for (const p of positions) {
    if (p.qty === 0) continue;
    groups.add(`${p.sleeveId}:${strategyOf(p)}:${p.asset}`);
  }
  return groups.size;
}

/**
 * Net delta per underlying asset, across venues and markets.
 *
 * The number that proves a "delta-neutral" strategy actually is. A carry
 * position holding +1 BTC spot and −1 BTC perp nets to zero here; if it does
 * not, the hedge has slipped and the position is quietly directional.
 */
export function assetDelta(marked: MarkedPosition[]): Map<string, number> {
  const delta = new Map<string, number>();
  for (const p of marked) {
    if (p.qty === 0) continue;
    delta.set(p.asset, (delta.get(p.asset) ?? 0) + p.qty);
  }
  return delta;
}
