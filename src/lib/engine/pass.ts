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
import { fetchFxQuotes } from "@/lib/market/forex";
import { fxBooks, fxPrices } from "@/lib/market/fxbook";
import { UNIVERSE } from "@/lib/market/types";
import { resolveTier, tierForNav } from "@/lib/calc/tiers";
import { scan } from "@/lib/engine/scanner";
import { scanForex } from "@/lib/engine/forexscan";
import { readConfig } from "@/lib/engine/store";
import { readHalt } from "@/lib/killswitch";
import { daysHeldAbove } from "@/lib/db/nav";
import { getFundState } from "@/lib/fund/nav";
import { buildPositions } from "@/lib/portfolio/positions";
import { accrueFxCarry } from "@/lib/oms/fxcarry";
import { SimulatedVenue, booksFromQuotes } from "@/lib/oms/simulated";
import { edgeAccuracy, runPaperPass } from "@/lib/oms/paper";
import {
  readFills,
  readFundingPayments,
  recordFills,
  recordFunding,
  recordOrders,
} from "@/lib/oms/store";
import { appendLog, readJson, writeJson } from "@/lib/store/kv";

/** Durable per-pass history. Read by the performance screen. */
export const TRADE_LOG = "trade_passes";

/** When FX carry was last accrued — the clock the accrual is measured against. */
const FX_CARRY_ACCRUAL_KEY = "fx_carry_last_accrual";
/** Clamp a long gap (deploy downtime) so a resumed pass cannot book a windfall. */
const MAX_ACCRUAL_MS = 24 * 60 * 60 * 1000;

/**
 * Book the FX carry earned since the last pass.
 *
 * Time-driven, so it runs exactly once per pass and advances its own clock. The
 * first ever pass sets the baseline and accrues nothing — there is no prior
 * interval to earn over.
 */
async function accrueCarry(
  fxQuotes: Awaited<ReturnType<typeof fetchFxQuotes>>,
): Promise<void> {
  const now = Date.now();
  const last = (await readJson<number>(FX_CARRY_ACCRUAL_KEY)) ?? 0;

  if (!last) {
    await writeJson(FX_CARRY_ACCRUAL_KEY, now);
    return;
  }

  const elapsedMs = Math.min(now - last, MAX_ACCRUAL_MS);
  if (elapsedMs <= 0) {
    await writeJson(FX_CARRY_ACCRUAL_KEY, now);
    return;
  }

  const [fills, funding] = await Promise.all([readFills(), readFundingPayments()]);
  const openFx = buildPositions(fills, funding).filter((p) => p.qty !== 0);
  const payments = accrueFxCarry(openFx, fxQuotes, elapsedMs, now);
  if (payments.length > 0) await recordFunding(payments);
  await writeJson(FX_CARRY_ACCRUAL_KEY, now);
}

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
  const [snapshot, fxQuotes, storedConfig, halt] = await Promise.all([
    fetchSnapshot(),
    fetchFxQuotes().catch(() => []),
    readConfig(),
    readHalt(),
  ]);

  const prices = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.last > 0 && !prices.has(q.asset)) prices.set(q.asset, q.last);
  }
  // FX pair rates, keyed by pair symbol — the key FX fills and marks share.
  for (const [symbol, rate] of fxPrices(fxQuotes)) prices.set(symbol, rate);

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

  const dataAgeSeconds = (Date.now() - snapshot.asOf) / 1000;

  // Accrue FX carry on positions held since the last pass, BEFORE any new
  // entries — a position starts earning carry the pass after it opens, never
  // the instant it opens. This books the interest differential as funding, the
  // same mechanism crypto uses.
  await accrueCarry(fxQuotes);

  const existingFills = await readFills();
  const fundingBefore = await readFundingPayments();

  const tier = resolveTier(fund.navUsd, daysHeldAboveThreshold, "T0").current;

  const opportunities = [
    ...scan({ config, snapshot, fundingHistory, daysHeldAboveThreshold, halted: false }),
    ...scanForex({ config, quotes: fxQuotes, tier, dataAgeSeconds, halted: false }),
  ];

  const venue = new SimulatedVenue();
  venue.setBooks([...booksFromQuotes(snapshot.quotes), ...fxBooks(fxQuotes)]);

  const result = await runPaperPass({
    config,
    opportunities,
    venue,
    prices,
    halted: false,
    dataAgeSeconds,
    daysHeldAboveThreshold,
    existingFills,
    funding: fundingBefore,
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
