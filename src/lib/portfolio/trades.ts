/**
 * Trade reconstruction — turning a stream of fills into round-trip trades.
 *
 * The fill log records every leg that traded; it does not, on its own, tell you
 * "we put on 14 carries, 9 made money, the average winner held 6 days." That is
 * the view that answers the only question that matters — *is the strategy
 * working* — and it is reconstructed here rather than stored, so it can never
 * drift from the fills that produced it.
 *
 * A trade is a **(sleeve, asset) episode**: the span from the group going from
 * flat to open, to it returning flat again. A funding carry is two legs (spot +
 * perp) under one (sleeve, asset), so this correctly treats the pair as one
 * trade rather than two — the same grouping the position and exit logic use.
 *
 * Realised P&L is the price P&L booked as the closing legs reduce the position;
 * funding is the carry earned while the episode was open; fees are every fill's
 * cost. Net is what actually landed.
 */

import { applyFill, type Fill, type FundingPayment, type Position } from "./positions";
import { sleeveById, type AssetClass } from "./sleeves";

export type CompletedTrade = {
  sleeveId: string;
  asset: string;
  account: AssetClass;
  /** The strategy that opened the trade. */
  strategy: string;
  openedAt: number;
  closedAt: number;
  durationMs: number;
  /** Price P&L booked on the closing legs. */
  realisedUsd: number;
  /** Funding / carry earned while the trade was open. */
  fundingUsd: number;
  feesUsd: number;
  /** realised + funding − fees. What the trade actually made. */
  netUsd: number;
  win: boolean;
};

export type OpenTrade = {
  sleeveId: string;
  asset: string;
  account: AssetClass;
  strategy: string;
  openedAt: number;
  ageMs: number;
  legs: number;
  fundingUsd: number;
  feesUsd: number;
};

export type TradeHistory = {
  completed: CompletedTrade[];
  open: OpenTrade[];
};

const EPS = 1e-9;

function accountOf(sleeveId: string): AssetClass {
  return sleeveById(sleeveId)?.assetClass ?? "crypto";
}

/**
 * Reconstruct completed and open trades from the fill and funding logs.
 *
 * `now` is injected for the age of open trades so the function stays pure.
 */
export function reconstructTrades(
  fills: Fill[],
  funding: FundingPayment[] = [],
  now: number = Date.now(),
): TradeHistory {
  // Group fills by (sleeve, asset) — the unit a trade is reasoned about in.
  const byGroup = new Map<string, Fill[]>();
  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    const k = `${f.sleeveId}:${f.asset}`;
    const list = byGroup.get(k);
    if (list) list.push(f);
    else byGroup.set(k, [f]);
  }

  // Funding grouped the same way, to attribute carry to the episode it fell in.
  const fundingByGroup = new Map<string, FundingPayment[]>();
  for (const p of funding) {
    const k = `${p.sleeveId}:${p.asset}`;
    const list = fundingByGroup.get(k);
    if (list) list.push(p);
    else fundingByGroup.set(k, [p]);
  }

  const completed: CompletedTrade[] = [];
  const open: OpenTrade[] = [];

  for (const [key, groupFills] of byGroup) {
    const [sleeveId, asset] = key.split(":");
    const legs = new Map<string, Position | null>(); // legKey -> position

    let epActive = false;
    let epOpenedAt = 0;
    let epStrategy = "";
    let epRealised = 0;
    let epFees = 0;
    let epLegKeys = new Set<string>();

    const groupFlat = () =>
      [...legs.values()].every((p) => !p || Math.abs(p.qty) < EPS);

    for (const f of groupFills) {
      const legKey = `${f.venue}:${f.market}`;
      const before = legs.get(legKey) ?? null;

      if (!epActive) {
        // A new episode begins with the fill that first takes the group off flat.
        epActive = true;
        epOpenedAt = f.ts;
        epStrategy = f.strategy;
        epRealised = 0;
        epFees = 0;
        epLegKeys = new Set();
      }

      const after = applyFill(before, f);
      legs.set(legKey, after);
      epLegKeys.add(legKey);
      epRealised += after.realisedUsd - (before?.realisedUsd ?? 0);
      epFees += f.feeUsd;

      if (epActive && groupFlat()) {
        // Episode closed. Attribute funding that fell within its window.
        const fundingUsd = (fundingByGroup.get(key) ?? [])
          .filter((p) => p.ts >= epOpenedAt && p.ts <= f.ts)
          .reduce((a, p) => a + p.amountUsd, 0);
        const netUsd = epRealised + fundingUsd - epFees;
        completed.push({
          sleeveId,
          asset,
          account: accountOf(sleeveId),
          strategy: epStrategy,
          openedAt: epOpenedAt,
          closedAt: f.ts,
          durationMs: f.ts - epOpenedAt,
          realisedUsd: epRealised,
          fundingUsd,
          feesUsd: epFees,
          netUsd,
          win: netUsd > 0,
        });
        epActive = false;
        // Reset leg positions so the next episode starts clean (they are flat).
        for (const k of epLegKeys) legs.set(k, null);
      }
    }

    // Anything still open is a live trade.
    if (epActive) {
      const fundingUsd = (fundingByGroup.get(key) ?? [])
        .filter((p) => p.ts >= epOpenedAt)
        .reduce((a, p) => a + p.amountUsd, 0);
      open.push({
        sleeveId,
        asset,
        account: accountOf(sleeveId),
        strategy: epStrategy,
        openedAt: epOpenedAt,
        ageMs: now - epOpenedAt,
        legs: [...legs.values()].filter((p) => p && Math.abs(p.qty) >= EPS).length,
        fundingUsd,
        feesUsd: epFees,
      });
    }
  }

  completed.sort((a, b) => b.closedAt - a.closedAt);
  open.sort((a, b) => a.openedAt - b.openedAt);
  return { completed, open };
}

export type TradeStats = {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  totalNetUsd: number;
  totalFundingUsd: number;
  grossWinUsd: number;
  grossLossUsd: number;
  avgWinUsd: number;
  avgLossUsd: number;
  /** Average net per trade — the expectancy of the strategy as run. */
  expectancyUsd: number;
  avgDurationMs: number;
  /** Profit factor: gross wins / |gross losses|. >1 is profitable. */
  profitFactor: number | null;
};

/** Win/loss summary over a set of completed trades. */
export function tradeStats(trades: CompletedTrade[]): TradeStats {
  const count = trades.length;
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const grossWinUsd = wins.reduce((a, t) => a + t.netUsd, 0);
  const grossLossUsd = losses.reduce((a, t) => a + t.netUsd, 0);
  const totalNetUsd = grossWinUsd + grossLossUsd;

  return {
    count,
    wins: wins.length,
    losses: losses.length,
    winRate: count > 0 ? wins.length / count : 0,
    totalNetUsd,
    totalFundingUsd: trades.reduce((a, t) => a + t.fundingUsd, 0),
    grossWinUsd,
    grossLossUsd,
    avgWinUsd: wins.length > 0 ? grossWinUsd / wins.length : 0,
    avgLossUsd: losses.length > 0 ? grossLossUsd / losses.length : 0,
    expectancyUsd: count > 0 ? totalNetUsd / count : 0,
    avgDurationMs: count > 0 ? trades.reduce((a, t) => a + t.durationMs, 0) / count : 0,
    profitFactor: grossLossUsd < 0 ? grossWinUsd / Math.abs(grossLossUsd) : null,
  };
}
