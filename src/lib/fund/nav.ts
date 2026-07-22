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
 *
 * **Per account.** Capital is split into a crypto book and a forex book, and so
 * is NAV. A position's P&L belongs to the account matching its sleeve's asset
 * class, so `crypto` NAV is crypto deposits + crypto trading, and likewise for
 * forex. The aggregate is just the two summed — it is never computed a second,
 * independent way, so the parts always add up to the whole.
 */

import { readFills, readFundingPayments } from "@/lib/oms/store";
import {
  buildPositions,
  countLogicalPositions,
  markPositions,
  type MarkedPosition,
} from "@/lib/portfolio/positions";
import { sleeveById } from "@/lib/portfolio/sleeves";
import { fetchSnapshot } from "@/lib/market/venues";
import { fetchFxQuotes } from "@/lib/market/forex";
import { fxPrices } from "@/lib/market/fxbook";
import {
  computeNav,
  computeAccountNav,
  readCapitalEvents,
  FUND_ACCOUNTS,
  type CapitalEvent,
  type FundAccount,
  type FundNav,
  type TradingPnl,
} from "./ledger";

/** Mark prices for everything we might hold — crypto and forex. */
export async function currentPrices(): Promise<Map<string, number>> {
  // FX is fetched alongside crypto so an FX position is never unmarkable just
  // because the price map came from the crypto feed. A failed FX fetch leaves
  // FX positions unpriced (excluded, not zeroed) rather than failing the whole
  // mark.
  const [snapshot, fx] = await Promise.all([
    fetchSnapshot(),
    fetchFxQuotes().catch(() => []),
  ]);

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
  // FX pair rates, keyed by the pair symbol — the same key FX fills use.
  for (const [symbol, rate] of fxPrices(fx)) prices.set(symbol, rate);
  return prices;
}

/** Which account a position belongs to, by its sleeve's asset class. */
export function accountForSleeve(sleeveId: string): FundAccount {
  return sleeveById(sleeveId)?.assetClass ?? "crypto";
}

const EMPTY_PNL: TradingPnl = {
  realisedUsd: 0,
  unrealisedUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  totalUsd: 0,
};

/**
 * Fold a set of marked positions into one P&L total.
 *
 * An unmarkable open position contributes null unrealised, which would make the
 * total unknowable — so unrealised is summed only over positions we can price,
 * and `unpriced` names the rest. Treating an unpriced holding as zero would
 * understate NAV while looking precise, and an understated NAV silently
 * tightens every limit derived from it.
 */
function foldPnl(marked: MarkedPosition[]): {
  pnl: TradingPnl;
  unpriced: string[];
  openPositions: number;
} {
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

export type PnlBreakdown = {
  pnl: TradingPnl;
  unpriced: string[];
  openPositions: number;
  /** The same split by account, so each book's NAV can be computed on its own. */
  byAccount: Record<FundAccount, { pnl: TradingPnl; unpriced: string[]; openPositions: number }>;
};

/**
 * Trading P&L from the fill log, aggregate and per account.
 *
 * Positions are marked once and then folded twice — once for the whole book,
 * once per account — so the account figures cannot disagree with the total.
 */
export async function tradingPnl(prices?: Map<string, number>): Promise<PnlBreakdown> {
  const emptyByAccount = (): PnlBreakdown["byAccount"] =>
    Object.fromEntries(
      FUND_ACCOUNTS.map((a) => [
        a.id,
        { pnl: EMPTY_PNL, unpriced: [] as string[], openPositions: 0 },
      ]),
    ) as PnlBreakdown["byAccount"];

  const [fills, funding] = await Promise.all([readFills(), readFundingPayments()]);

  if (fills.length === 0) {
    return { pnl: EMPTY_PNL, unpriced: [], openPositions: 0, byAccount: emptyByAccount() };
  }

  const marks = prices ?? (await currentPrices());
  const marked = markPositions(buildPositions(fills, funding), marks);

  const byAccount = emptyByAccount();
  for (const a of FUND_ACCOUNTS) {
    byAccount[a.id] = foldPnl(marked.filter((p) => accountForSleeve(p.sleeveId) === a.id));
  }

  return { ...foldPnl(marked), byAccount };
}

export type FundState = FundNav & {
  events: CapitalEvent[];
  unpriced: string[];
  openPositions: number;
};

export type AccountState = FundState & { account: FundAccount };

export type FundStateFull = FundState & {
  /** Same shape, one per account. The two accounts sum to this aggregate. */
  accounts: AccountState[];
};

/**
 * Full fund state — aggregate plus each account.
 *
 * `prices` can be passed in by callers that already have a market snapshot, so
 * a single request does not fetch the same data twice.
 */
export async function getFundState(prices?: Map<string, number>): Promise<FundStateFull> {
  const [events, breakdown] = await Promise.all([readCapitalEvents(), tradingPnl(prices)]);

  const accounts: AccountState[] = FUND_ACCOUNTS.map((a) => {
    const b = breakdown.byAccount[a.id];
    return {
      account: a.id,
      ...computeAccountNav(events, a.id, b.pnl),
      events: events.filter((e) => e.account === a.id),
      unpriced: b.unpriced,
      openPositions: b.openPositions,
    };
  });

  return {
    ...computeNav(events, breakdown.pnl),
    events,
    unpriced: breakdown.unpriced,
    openPositions: breakdown.openPositions,
    accounts,
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
