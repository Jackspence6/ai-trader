/**
 * One trading pass — scan, gate, execute, record.
 *
 * Extracted from the CLI so the loop on a box and the cron on the deployment
 * run **the same code**, not two copies that drift. Two implementations of "the
 * thing that decides trades" is exactly how you end up with a system that
 * behaves differently depending on which machine happened to be awake.
 *
 * Every pass writes a durable record: NAV before and after, the P&L split, each
 * execution with predicted vs realised cost, and every rejection reason counted.
 * The balance alone cannot answer "where did the money come from, and why" — the
 * decisions can, and only if they were kept.
 */

import { fetchSnapshot, fetchBinanceFundingHistory } from "@/lib/market/venues";
import { UNIVERSE } from "@/lib/market/types";
import { scan } from "@/lib/engine/scanner";
import { readConfig } from "@/lib/engine/store";
import { readHalt } from "@/lib/killswitch";
import { daysHeldAbove } from "@/lib/db/nav";
import { tierForNav } from "@/lib/calc/tiers";
import { getFundState } from "@/lib/fund/nav";
import { SimulatedVenue, booksFromQuotes } from "@/lib/oms/simulated";
import { edgeAccuracy, runPaperPass } from "@/lib/oms/paper";
import { readFills, readFundingPayments, recordFills, recordOrders } from "@/lib/oms/store";
import { appendLog } from "@/lib/store/kv";

/** Durable per-pass history. Read by the performance screen. */
export const TRADE_LOG = "trade_passes";

export type TradePassRecord = {
  ts: number;
  navBefore: number;
  navAfter: number;
  pnl: {
    realisedUsd: number;
    unrealisedUsd: number;
    fundingUsd: number;
    feesUsd: number;
    totalUsd: number;
  };
  scored: number;
  executed: number;
  rejected: number;
  openPositions: number;
  accuracy: ReturnType<typeof edgeAccuracy>;
  rejections: Record<string, number>;
  executions: {
    asset: string;
    strategy: string;
    sleeveId: string;
    venue: string;
    predictedNetBps: number;
    predictedEntryCostBps: number;
    realisedEntryCostBps: number | null;
  }[];
  /** Set when the pass did nothing, and why. */
  skipped: string | null;
};

export type PassOutcome = {
  record: TradePassRecord;
  /** One-line summary, for logs. */
  summary: string;
};

export async function runTradingPass(): Promise<PassOutcome> {
  const [snapshot, storedConfig, halt] = await Promise.all([
    fetchSnapshot(),
    readConfig(),
    readHalt(),
  ]);

  const prices = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.last > 0 && !prices.has(q.asset)) prices.set(q.asset, q.last);
  }

  const fund = await getFundState(prices);

  const skeleton = (skipped: string): PassOutcome => ({
    record: {
      ts: Date.now(),
      navBefore: fund.navUsd,
      navAfter: fund.navUsd,
      pnl: fund.pnl,
      scored: 0,
      executed: 0,
      rejected: 0,
      openPositions: fund.openPositions,
      accuracy: [],
      rejections: {},
      executions: [],
      skipped,
    },
    summary: skipped,
  });

  // A skipped pass is still recorded. A gap in the history is ambiguous —
  // "halted" and "the box was asleep" look identical unless one says so.
  if (halt.halted) {
    const out = skeleton(`halted — ${halt.reason ?? "no reason recorded"}`);
    await appendLog(TRADE_LOG, [out.record]);
    return out;
  }

  if (fund.navUsd <= 0) {
    const out = skeleton("no capital — record a deposit on Treasury");
    await appendLog(TRADE_LOG, [out.record]);
    return out;
  }

  const config = { ...storedConfig, navUsd: fund.navUsd };

  let daysHeldAboveThreshold = 0;
  try {
    daysHeldAboveThreshold = await daysHeldAbove(tierForNav(fund.navUsd).minNavUsd);
  } catch {
    daysHeldAboveThreshold = 0;
  }

  const histories = await Promise.allSettled(
    UNIVERSE.map((a) => fetchBinanceFundingHistory(a, config.fundingRegimeWindow)),
  );
  const fundingHistory: Record<string, number[]> = {};
  histories.forEach((h, i) => {
    if (h.status === "fulfilled") {
      fundingHistory[`Binance:${UNIVERSE[i]}`] = h.value.map((r) => r.apr);
    }
  });

  const opportunities = scan({
    config,
    snapshot,
    fundingHistory,
    daysHeldAboveThreshold,
    halted: false,
  });

  const venue = new SimulatedVenue();
  venue.setBooks(booksFromQuotes(snapshot.quotes));

  const result = await runPaperPass({
    config,
    opportunities,
    venue,
    prices,
    halted: false,
    dataAgeSeconds: (Date.now() - snapshot.asOf) / 1000,
    daysHeldAboveThreshold,
    existingFills: await readFills(),
    funding: await readFundingPayments(),
  });

  const orders = result.decisions.flatMap((d) => (d.executed ? d.orders : []));
  await Promise.all([recordOrders(orders), recordFills(result.fills)]);

  const after = await getFundState(prices);

  const record: TradePassRecord = {
    ts: Date.now(),
    navBefore: fund.navUsd,
    navAfter: after.navUsd,
    pnl: after.pnl,
    scored: opportunities.length,
    executed: result.executed,
    rejected: result.rejected,
    openPositions: after.openPositions,
    accuracy: edgeAccuracy(result.decisions),
    rejections: result.decisions
      .filter((d) => !d.executed)
      .reduce<Record<string, number>>((a, d) => {
        const k = d.rejectionCode ?? "unknown";
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {}),
    executions: result.decisions
      .filter((d) => d.executed)
      .map((d) => ({
        asset: d.asset,
        strategy: d.strategy,
        sleeveId: d.sleeveId,
        // Recorded per execution so profitability can later be attributed by
        // venue, not just by strategy — "where is this working" is a venue
        // question as much as a strategy one.
        venue: d.fills[0]?.venue ?? "unknown",
        predictedNetBps: d.predictedNetBps,
        predictedEntryCostBps: d.predictedEntryCostBps,
        realisedEntryCostBps: d.realisedEntryCostBps,
      })),
    skipped: null,
  };

  await appendLog(TRADE_LOG, [record]);

  const delta = after.navUsd - fund.navUsd;
  return {
    record,
    summary:
      `scored ${record.scored} · executed ${record.executed} · ` +
      `open ${record.openPositions} · NAV $${after.navUsd.toFixed(2)} ` +
      `(${delta >= 0 ? "+" : ""}${delta.toFixed(4)})`,
  };
}
