#!/usr/bin/env tsx
/**
 * The trading loop.
 *
 *   pnpm trade                run continuously
 *   pnpm trade --once         a single pass, then exit
 *   pnpm trade --interval 60  seconds between passes (default 300)
 *
 * This is the always-on process. It scans live markets, runs every candidate
 * through the risk gate, executes what survives against the paper venue, and
 * records the outcome — the same loop a live engine runs, with a venue that
 * cannot reach an exchange.
 *
 * **Why this cannot live on Vercel.** Serverless functions run when a request
 * arrives and stop when it is answered; there is no process to hold a loop.
 * Vercel Cron can invoke a route on a schedule, but the free tier allows two
 * invocations per DAY, which is not a trading system. This belongs on a box
 * that stays up — and it shares state with the dashboard through Postgres, so
 * both see the same book.
 *
 * Failure policy matches the recorder: a pass that throws is logged and
 * skipped. The loop never exits on a venue or network error, because those are
 * exactly the conditions worth having a record of.
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

const args = process.argv.slice(2);
const once = args.includes("--once");
const intervalIdx = args.indexOf("--interval");
const intervalSec = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) || 300 : 300;

/** Per-pass summary, so performance can be reconstructed later. */
export const TRADE_LOG = "trade_passes";

function stamp() {
  return new Date().toISOString();
}

async function runPass(): Promise<void> {
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
  const config = { ...storedConfig, navUsd: fund.navUsd };

  if (halt.halted) {
    console.log(`[${stamp()}] HALTED — ${halt.reason ?? "no reason recorded"}`);
    return;
  }

  if (fund.navUsd <= 0) {
    console.log(
      `[${stamp()}] no capital — record a deposit on Treasury before this can trade`,
    );
    return;
  }

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

  // A durable per-pass record. The point is being able to answer "where did the
  // money come from, and why" weeks later — which needs the decision, not just
  // the resulting balance.
  const after = await getFundState(prices);
  const accuracy = edgeAccuracy(result.decisions);

  await appendLog(TRADE_LOG, [
    {
      ts: Date.now(),
      navBefore: fund.navUsd,
      navAfter: after.navUsd,
      pnl: after.pnl,
      scored: opportunities.length,
      executed: result.executed,
      rejected: result.rejected,
      accuracy,
      openPositions: after.openPositions,
      // Every rejection reason, counted. This is how "why is it not trading?"
      // stays answerable after the fact.
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
          predictedNetBps: d.predictedNetBps,
          predictedEntryCostBps: d.predictedEntryCostBps,
          realisedEntryCostBps: d.realisedEntryCostBps,
        })),
    },
  ]);

  const delta = after.navUsd - fund.navUsd;
  console.log(
    `[${stamp()}] scored ${opportunities.length} · executed ${result.executed} · ` +
      `open ${after.openPositions} · NAV $${after.navUsd.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(4)})`,
  );

  for (const a of accuracy) {
    console.log(
      `             ${a.strategy}: predicted ${a.meanPredictedCostBps.toFixed(2)}bp · ` +
        `realised ${a.meanRealisedCostBps.toFixed(2)}bp · error ${a.meanErrorBps >= 0 ? "+" : ""}${a.meanErrorBps.toFixed(2)}bp`,
    );
  }
}

async function main() {
  console.log(
    `Trading loop starting — paper venue, ${once ? "single pass" : `every ${intervalSec}s`}`,
  );
  console.log("Nothing here can reach an exchange.\n");

  const safePass = async () => {
    try {
      await runPass();
    } catch (e) {
      console.error(`[${stamp()}] pass failed:`, e instanceof Error ? e.message : e);
    }
  };

  await safePass();
  if (once) return;

  const timer = setInterval(safePass, intervalSec * 1000);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} — stopping. Positions and the ledger are unchanged.`);
      clearInterval(timer);
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error("Trading loop failed to start:", e);
  process.exit(1);
});
