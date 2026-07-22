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
import { buildPositions, markPositions, sleevePnl, type Fill } from "@/lib/portfolio/positions";
import { sleeveById } from "@/lib/portfolio/sleeves";
import { accrueFxCarry } from "@/lib/oms/fxcarry";
import { evaluateExits } from "@/lib/oms/exits";
import { evaluateRisk, type RiskState, type RiskBreach } from "./risk";
import { writeConfig } from "./store";
import { halt as haltTrading } from "@/lib/killswitch/state";
import { SimulatedVenue, booksFromQuotes } from "@/lib/oms/simulated";
import { newIntentId, type Order } from "@/lib/oms/types";
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
/** Persistent risk state: high-water marks and the daily baseline. */
export const RISK_STATE_KEY = "risk_state";
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

/**
 * Close every open trade whose thesis has broken.
 *
 * A trade is closed as a whole or not at all: if any leg cannot close (e.g. it
 * would fall below the venue minimum), none of that trade's closing fills are
 * recorded, so it stays intact and is retried next pass rather than left as a
 * naked half-position.
 */
async function processExits(
  venue: SimulatedVenue,
  fills: Fill[],
  funding: Awaited<ReturnType<typeof readFundingPayments>>,
  prices: Map<string, number>,
  snapshot: Awaited<ReturnType<typeof fetchSnapshot>>,
  fxQuotes: Awaited<ReturnType<typeof fetchFxQuotes>>,
): Promise<{ fills: Fill[]; orders: Order[]; reasons: Record<string, number> }> {
  const marked = markPositions(buildPositions(fills, funding), prices);

  const fundingMap = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.kind === "perp" && q.fundingApr !== undefined) {
      fundingMap.set(`${q.venue}:${q.asset}`, q.fundingApr);
    }
  }
  const fxPairs = new Map(fxQuotes.map((q) => [q.symbol, { base: q.base, quote: q.quote }]));

  const plans = evaluateExits(marked, {
    fundingApr: (v, a) => fundingMap.get(`${v}:${a}`),
    fxPair: (s) => fxPairs.get(s),
  });

  const outFills: Fill[] = [];
  const outOrders: Order[] = [];
  const reasons: Record<string, number> = {};

  for (const plan of plans) {
    const planFills: Fill[] = [];
    const planOrders: Order[] = [];
    let closedAll = true;

    for (const leg of plan.legs) {
      const res = await venue.submit({
        id: newIntentId(),
        ts: Date.now(),
        venue: String(leg.venue),
        asset: leg.asset,
        market: leg.market,
        side: leg.qty > 0 ? "sell" : "buy",
        qty: Math.abs(leg.qty),
        type: "market",
        timeInForce: "IOC",
        sleeveId: leg.sleeveId,
        strategy: "exit",
        rationale: `Exit (${plan.reason}): ${plan.detail}`,
        reduceOnly: true,
      });
      if (res.ok) {
        planFills.push(...res.fills);
        planOrders.push(res.order);
      } else {
        closedAll = false;
      }
    }

    if (closedAll && planFills.length > 0) {
      outFills.push(...planFills);
      outOrders.push(...planOrders);
      reasons[plan.reason] = (reasons[plan.reason] ?? 0) + 1;
    }
  }

  return { fills: outFills, orders: outOrders, reasons };
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
  /** Trades closed this pass by the exit manager, and why. */
  closed: number;
  exits: Record<string, number>;
  /** Risk-limit breaches observed this pass (fund and per-sleeve). */
  riskBreaches: RiskBreach[];
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
      closed: 0,
      exits: {},
      riskBreaches: [],
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

  // --- risk enforcement: measure the book against its limits before trading ---
  // A sleeve past its drawdown limit is halted (that sleeve only); the fund past
  // its drawdown or daily-loss limit trips the global halt and this pass stops.
  const preMarked = markPositions(buildPositions(existingFills, fundingBefore), prices);
  const sleevePnls = sleevePnl(preMarked);
  const riskPrev = await readJson<RiskState>(RISK_STATE_KEY);
  const risk = evaluateRisk({
    navUsd: fund.navUsd,
    dayKey: new Date().toISOString().slice(0, 10),
    fund: { dailyLossPct: config.dailyLossLimitPct, maxDrawdownPct: config.maxDrawdownPct },
    sleeves: config.sleeves
      .filter((s) => s.enabled && s.allocatedUsd > 0)
      .map((s) => {
        const def = sleeveById(s.sleeveId);
        const pnl = sleevePnls.find((p) => p.sleeveId === s.sleeveId);
        return {
          id: s.sleeveId,
          name: def?.name ?? s.sleeveId,
          equityUsd: s.allocatedUsd + (pnl?.totalUsd ?? 0),
          maxDrawdownPct: def?.limits.maxDrawdownPct ?? 1,
          alreadyHalted: s.halted,
        };
      }),
    prev: riskPrev,
  });
  await writeJson(RISK_STATE_KEY, risk.state);

  // Sleeve breach → halt that sleeve only. Persist it and apply to this pass so
  // its entries are blocked immediately.
  if (risk.sleeveHalts.length > 0) {
    const halting = new Set(risk.sleeveHalts.map((h) => h.id));
    config.sleeves = config.sleeves.map((s) =>
      halting.has(s.sleeveId) ? { ...s, halted: true } : s,
    );
    await writeConfig(config);
  }

  // Fund breach → global halt. Trip it and stop; the next pass sees it halted.
  if (risk.fundBreach) {
    await haltTrading(risk.fundBreach.detail, "auto");
    const out = skeleton(`risk halt — ${risk.fundBreach.detail}`);
    out.record.riskBreaches = risk.breaches;
    await appendLog(TRADE_LOG, [out.record]);
    return out;
  }

  const tier = resolveTier(fund.navUsd, daysHeldAboveThreshold, "T0").current;

  const opportunities = [
    ...scan({ config, snapshot, fundingHistory, daysHeldAboveThreshold, halted: false }),
    ...scanForex({ config, quotes: fxQuotes, tier, dataAgeSeconds, halted: false }),
  ];

  const venue = new SimulatedVenue();
  venue.setBooks([...booksFromQuotes(snapshot.quotes), ...fxBooks(fxQuotes)]);

  // Close first, open second. A trade whose thesis has broken — funding
  // inverted, FX carry decayed, or a stop breached — is closed before new
  // entries are considered, so the freed position slot and capital are
  // available to the same pass rather than a later one.
  const exit = await processExits(venue, existingFills, fundingBefore, prices, snapshot, fxQuotes);
  if (exit.orders.length > 0) await recordOrders(exit.orders);

  const result = await runPaperPass({
    config,
    opportunities,
    venue,
    prices,
    halted: false,
    dataAgeSeconds,
    daysHeldAboveThreshold,
    // Entries see the book AFTER exits — the closing fills are part of the state.
    existingFills: [...existingFills, ...exit.fills],
    funding: fundingBefore,
  });

  const orders = result.decisions.flatMap((d) => (d.executed ? d.orders : []));
  await Promise.all([
    recordOrders(orders),
    recordFills([...exit.fills, ...result.fills]),
  ]);

  const after = await getFundState(prices);

  const record: TradePassRecord = {
    ts: Date.now(),
    navBefore: fund.navUsd,
    navAfter: after.navUsd,
    pnl: after.pnl,
    scored: opportunities.length,
    executed: result.executed,
    rejected: result.rejected,
    closed: Object.values(exit.reasons).reduce((a, n) => a + n, 0),
    exits: exit.reasons,
    riskBreaches: risk.breaches,
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
      `closed ${record.closed} · open ${record.openPositions} · ` +
      `NAV $${after.navUsd.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(4)})`,
  };
}
