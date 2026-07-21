/**
 * The single source of NAV.
 *
 * Everything that sizes a position, gates a tier, or reports performance reads
 * from here. One function, so there is no way for the Treasury screen and the
 * risk gate to disagree about how much money there is — which is exactly the
 * kind of divergence that produces a position sized against a number nobody
 * else believes.
 *
 * NAV = net capital contributed + trading P&L. Both halves are replayed from
 * their own event logs rather than cached, so the figure cannot drift from the
 * events that produced it.
 */

import { readFills, readFundingPayments } from "@/lib/oms/store";
import {
  buildPositions,
  countLogicalPositions,
  markPositions,
} from "@/lib/portfolio/positions";
import { fetchSnapshot } from "@/lib/market/venues";
import {
  computeNav,
  readCapitalEvents,
  type CapitalEvent,
  type FundNav,
  type TradingPnl,
} from "./ledger";

/** Mark prices for everything we might hold. */
export async function currentPrices(): Promise<Map<string, number>> {
  const snapshot = await fetchSnapshot();
  const prices = new Map<string, number>();
  // Spot first — it is the cleaner mark. Perp fills any gaps for assets with
  // no spot book on our venues.
  for (const q of snapshot.quotes) {
    if (q.kind === "spot" && q.last > 0 && !prices.has(q.asset)) {
      prices.set(q.asset, q.last);
    }
  }
  for (const q of snapshot.quotes) {
    if (q.last > 0 && !prices.has(q.asset)) prices.set(q.asset, q.last);
  }
  return prices;
}

/**
 * Trading P&L from the fill log.
 *
 * An unmarkable position contributes null unrealised, which would make the
 * total unknowable — so unrealised is summed only over positions we can price,
 * and `unpriced` names the rest. Treating an unpriced holding as zero would
 * understate NAV while looking precise, and an understated NAV silently
 * tightens every limit derived from it.
 */
export async function tradingPnl(
  prices?: Map<string, number>,
): Promise<{ pnl: TradingPnl; unpriced: string[]; openPositions: number }> {
  const [fills, funding] = await Promise.all([readFills(), readFundingPayments()]);

  if (fills.length === 0) {
    return {
      pnl: { realisedUsd: 0, unrealisedUsd: 0, fundingUsd: 0, feesUsd: 0, totalUsd: 0 },
      unpriced: [],
      openPositions: 0,
    };
  }

  const marks = prices ?? (await currentPrices());
  const marked = markPositions(buildPositions(fills, funding), marks);
  const open = marked.filter((p) => p.qty !== 0);

  const realisedUsd = marked.reduce((a, p) => a + p.realisedUsd, 0);
  const fundingUsd = marked.reduce((a, p) => a + p.fundingUsd, 0);
  const feesUsd = marked.reduce((a, p) => a + p.feesUsd, 0);
  const unrealisedUsd = open.reduce((a, p) => a + (p.unrealisedUsd ?? 0), 0);

  return {
    pnl: {
      realisedUsd,
      unrealisedUsd,
      fundingUsd,
      feesUsd,
      totalUsd: realisedUsd + unrealisedUsd + fundingUsd - feesUsd,
    },
    unpriced: open.filter((p) => p.markPrice === null).map((p) => p.asset),
    // Logical positions, matching what the risk gate counts. Reporting legs
    // here while the limit counts trades makes "2 open, limit 1" look broken
    // when it is correct.
    openPositions: countLogicalPositions(marked),
  };
}

export type FundState = FundNav & {
  events: CapitalEvent[];
  unpriced: string[];
  openPositions: number;
};

/**
 * Full fund state.
 *
 * `prices` can be passed in by callers that already have a market snapshot, so
 * a single request does not fetch the same data twice.
 */
export async function getFundState(prices?: Map<string, number>): Promise<FundState> {
  const [events, pnlResult] = await Promise.all([
    readCapitalEvents(),
    tradingPnl(prices),
  ]);

  return {
    ...computeNav(events, pnlResult.pnl),
    events,
    unpriced: pnlResult.unpriced,
    openPositions: pnlResult.openPositions,
  };
}

/**
 * Just the NAV number, for hot paths.
 *
 * Falls back to zero rather than throwing. A NAV we cannot compute must not
 * become a NAV we invent — zero halts sizing, which is the safe direction.
 */
export async function getNavUsd(prices?: Map<string, number>): Promise<number> {
  try {
    return (await getFundState(prices)).navUsd;
  } catch {
    return 0;
  }
}
