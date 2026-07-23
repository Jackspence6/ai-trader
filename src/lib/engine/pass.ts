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

import { fetchSnapshot, fetchBinanceFundingHistory, fetchCandles, type Candle } from "@/lib/market/venues";
import { FX_PAIRS, fetchFxHistory, fetchFxQuotes } from "@/lib/market/forex";
import { evaluateFxTrend, trendStopFraction } from "@/lib/calc/fxsignal";
import { fxBooks, fxPrices } from "@/lib/market/fxbook";
import { UNIVERSE } from "@/lib/market/types";
import { resolveTier, tierForNav } from "@/lib/calc/tiers";
import { scan } from "@/lib/engine/scanner";
import { scanForex, scanForexTrend } from "@/lib/engine/forexscan";
import { scanStablePeg } from "@/lib/engine/pegscan";
import { cryptoTrendExitState, scanCryptoTrend } from "@/lib/engine/trendscan";
import { fetchStableQuotes, pegDiscount } from "@/lib/market/stables";
import { readConfig } from "@/lib/engine/store";
import { readHalt } from "@/lib/killswitch";
import { daysHeldAbove, recordNav } from "@/lib/db/nav";
import { getFundState } from "@/lib/fund/nav";
import { buildPositions, markPositions, sleevePnl, type Fill } from "@/lib/portfolio/positions";
import { sleeveById } from "@/lib/portfolio/sleeves";
import { accrueFxCarry } from "@/lib/oms/fxcarry";
import { accruePerpFunding } from "@/lib/oms/perpfunding";
import {
  buildDataset,
  persistenceProbability,
  trainLogistic,
  type FundingSample,
} from "@/lib/ml/persistence";
import {
  appendMatured,
  maturePredictions,
  readMatured,
  readPending,
  readScoreboard,
  scorePredictions,
  writePending,
  writeScoreboard,
  type PredictionRecord,
} from "@/lib/ml/ledger";
import { classifyFundingRegime } from "@/lib/calc/funding";
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

/**
 * When carry income was last accrued — the clock the accrual is measured
 * against. One clock for both books (FX carry and crypto perp funding): they
 * accrue in the same place on the same elapsed interval, so separate clocks
 * could only drift apart and double- or under-book one side. The key name
 * predates crypto accrual and is kept so an existing deployment's clock
 * carries over instead of resetting.
 */
const FX_CARRY_ACCRUAL_KEY = "fx_carry_last_accrual";
/** Persistent risk state: high-water marks and the daily baseline. */
export const RISK_STATE_KEY = "risk_state";
/** Clamp a long gap (deploy downtime) so a resumed pass cannot book a windfall. */
const MAX_ACCRUAL_MS = 24 * 60 * 60 * 1000;

/**
 * Book the carry earned since the last pass — FX interest differential AND
 * crypto perp funding, over the same elapsed interval.
 *
 * Time-driven, so it runs exactly once per pass and advances its own clock. The
 * first ever pass sets the baseline and accrues nothing — there is no prior
 * interval to earn over.
 */
async function accrueCarry(
  fxQuotes: Awaited<ReturnType<typeof fetchFxQuotes>>,
  fundingApr: (venue: string, asset: string) => number | undefined,
  prices: Map<string, number>,
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
  const open = buildPositions(fills, funding).filter((p) => p.qty !== 0);
  const payments = [
    ...accrueFxCarry(open, fxQuotes, elapsedMs, now),
    ...accruePerpFunding(open, fundingApr, (a) => prices.get(a), elapsedMs, now),
  ];
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
  fundingApr: (venue: string, asset: string) => number | undefined,
  fundingMedianApr: (venue: string, asset: string) => number | undefined,
  fxQuotes: Awaited<ReturnType<typeof fetchFxQuotes>>,
  fxCloses: Record<string, number[]>,
  stableDiscounts: Map<string, number>,
  cryptoTrendExit?: (asset: string, openedAt: number) => { bandExit: boolean; trailExit: boolean } | undefined,
): Promise<{ fills: Fill[]; orders: Order[]; reasons: Record<string, number> }> {
  const marked = markPositions(buildPositions(fills, funding), prices);

  const fxPairs = new Map(fxQuotes.map((q) => [q.symbol, { base: q.base, quote: q.quote }]));

  const plans = evaluateExits(marked, {
    fundingApr,
    fundingMedianApr,
    fxPair: (s) => fxPairs.get(s),
    stableDiscount: (a) => stableDiscounts.get(a),
    cryptoTrendExit,
    fxTrend: (s) =>
      fxCloses[s] ? evaluateFxTrend(s, fxCloses[s]).direction : undefined,
    fxTrendStop: (s) => {
      const vol = fxCloses[s] ? evaluateFxTrend(s, fxCloses[s]).annualisedVol : null;
      return vol ? trendStopFraction(vol) : undefined;
    },
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
  const [baseSnapshot, stableQuotes, fxQuotes, storedConfig, halt] = await Promise.all([
    fetchSnapshot(),
    fetchStableQuotes().catch(() => []),
    fetchFxQuotes().catch(() => []),
    readConfig(),
    readHalt(),
  ]);

  // Stable quotes ride inside the snapshot so prices, simulated books and
  // exits see USDC like any other spot asset. They have no perp, so the
  // carry/spread scanners simply never match them.
  const snapshot = {
    ...baseSnapshot,
    quotes: [...baseSnapshot.quotes, ...stableQuotes],
  };

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

  // Fetch a deep funding window: the regime filter and exits use the last
  // `fundingRegimeWindow` intervals exactly as before, and the deeper history
  // trains the persistence model. Same one call per asset either way.
  const histories = await Promise.allSettled(
    UNIVERSE.map((a) =>
      fetchBinanceFundingHistory(a, Math.max(400, config.fundingRegimeWindow)),
    ),
  );
  const fundingHistory: Record<string, number[]> = {};
  const fundingSeries: Record<string, FundingSample[]> = {};
  const fundingTimed: Record<string, { t: number; rate: number }[]> = {};
  histories.forEach((h, i) => {
    if (h.status === "fulfilled") {
      const key = `Binance:${UNIVERSE[i]}`;
      fundingSeries[key] = h.value.map((r) => ({ rate: r.rate, apr: r.apr }));
      fundingTimed[key] = h.value.map((r) => ({ t: r.t, rate: r.rate }));
      fundingHistory[key] = h.value
        .slice(-config.fundingRegimeWindow)
        .map((r) => r.apr);
    }
  });

  // Persistence model, retrained each pass on the fetched history (a few
  // milliseconds; deterministic). SHADOW: the probabilities annotate scored
  // opportunities and are recorded with them — nothing gates on them until
  // the live track record earns it.
  const persistence: Record<string, number> = {};
  const pooledExamples = Object.values(fundingSeries).flatMap((s) => buildDataset(s));
  if (pooledExamples.length >= 200) {
    const model = trainLogistic(pooledExamples);
    for (const [key, s] of Object.entries(fundingSeries)) {
      const p = persistenceProbability(model, s);
      if (p !== null) persistence[key] = p;
    }
  }

  const dataAgeSeconds = (Date.now() - snapshot.asOf) / 1000;

  // Live and historical funding, shared by accrual and exits.
  const fundingMap = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.kind === "perp" && q.fundingApr !== undefined) {
      fundingMap.set(`${q.venue}:${q.asset}`, q.fundingApr);
    }
  }
  const fundingApr = (v: string, a: string) => fundingMap.get(`${v}:${a}`);
  const fundingMedianApr = (v: string, a: string) => {
    const history = fundingHistory[`${v}:${a}`];
    if (!history || history.length === 0) return undefined;
    return classifyFundingRegime(history)?.medianApr;
  };

  // Accrue carry on positions held since the last pass, BEFORE any new
  // entries — a position starts earning the pass after it opens, never the
  // instant it opens. Books the FX interest differential and crypto perp
  // funding through the same FundingPayment mechanism.
  await accrueCarry(fxQuotes, fundingApr, prices);

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

  // Daily closes per FX pair, for the trend signal and its exits. A pair whose
  // history fetch fails simply produces no trend opportunity this pass.
  // Daily candles for the H1 trend scan and its Donchian exit.
  const candleSettled = await Promise.allSettled(
    UNIVERSE.map(async (a) => [a, await fetchCandles(a, "1d", 150)] as const),
  );
  const candles: Record<string, Candle[]> = {};
  for (const c of candleSettled) {
    if (c.status === "fulfilled") candles[c.value[0]] = c.value[1];
  }

  const fxHistories = await Promise.allSettled(
    FX_PAIRS.map(async (p) => {
      const h = await fetchFxHistory(p.symbol, 120);
      return [p.symbol, h.map((d) => d.rate)] as const;
    }),
  );
  const fxCloses: Record<string, number[]> = {};
  for (const h of fxHistories) {
    if (h.status === "fulfilled") fxCloses[h.value[0]] = h.value[1];
  }

  const opportunities = [
    ...scan({
      config, snapshot, fundingHistory, daysHeldAboveThreshold, halted: false, persistence,
    }),
    ...scanStablePeg({ config, quotes: stableQuotes, tier, dataAgeSeconds, halted: false }),
    ...scanForex({ config, quotes: fxQuotes, tier, dataAgeSeconds, halted: false }),
    ...scanForexTrend({
      config, quotes: fxQuotes, tier, dataAgeSeconds, halted: false, closes: fxCloses,
    }),
    ...scanCryptoTrend({ config, candles, tier, dataAgeSeconds, halted: false }),
  ];

  const venue = new SimulatedVenue();
  venue.setBooks([...booksFromQuotes(snapshot.quotes), ...fxBooks(fxQuotes)]);

  // Close first, open second. A trade whose thesis has broken — funding
  // inverted, FX carry decayed, or a stop breached — is closed before new
  // entries are considered, so the freed position slot and capital are
  // available to the same pass rather than a later one.
  const stableDiscounts = new Map(stableQuotes.map((q) => [q.asset, pegDiscount(q.ask)]));
  const cryptoTrendExit = (asset: string, openedAt: number) =>
    candles[asset] ? cryptoTrendExitState(candles[asset], openedAt) ?? undefined : undefined;
  const exit = await processExits(
    venue, existingFills, fundingBefore, prices, fundingApr, fundingMedianApr,
    fxQuotes, fxCloses, stableDiscounts, cryptoTrendExit,
  );
  if (exit.orders.length > 0) await recordOrders(exit.orders);

  // The model's live standing decides whether it may veto weak L1 entries.
  // Evidence-gated: shadow until the matured ledger beats the baseline.
  const scoreboardBefore = await readScoreboard().catch(() => null);
  const mlConfirming = scoreboardBefore?.status === "confirming";

  const result = await runPaperPass({
    config,
    opportunities,
    venue,
    prices,
    mlConfirming,
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

  // --- prediction ledger: record, mature, score ----------------------------
  // Every live prediction is written down now and graded in 7 days against
  // what funding actually did. This is the loop that lets the model earn (and
  // lose) gating power on evidence rather than on its backtest.
  try {
    const now = Date.now();
    const executedL1 = new Set(
      result.decisions
        .filter((d) => d.executed && d.strategy === "L1")
        .map((d) => d.asset),
    );
    const newRows: PredictionRecord[] = Object.entries(persistence).map(
      ([key, probability]) => {
        const aprs = fundingHistory[key] ?? [];
        const sorted = [...aprs].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median =
          sorted.length === 0
            ? 0
            : sorted.length % 2 === 0
              ? (sorted[mid - 1] + sorted[mid]) / 2
              : sorted[mid];
        return {
          ts: now,
          key,
          probability,
          baselineSaysPersist: median > 0,
          executed: executedL1.has(key.split(":")[1]),
        };
      },
    );

    const pendingRows = [...(await readPending()), ...newRows];
    const { stillPending, matured } = maturePredictions(
      pendingRows,
      (key, ts) =>
        fundingTimed[key]?.filter((r) => r.t > ts).map((r) => r.rate),
      now,
    );
    if (matured.length > 0) await appendMatured(matured);
    await writePending(stillPending);
    const allMatured = await readMatured();
    await writeScoreboard(scorePredictions(allMatured, stillPending.length, now));
  } catch {
    // Ledger bookkeeping must never fail a trading pass.
  }

  const after = await getFundState(prices);

  // Record NAV straight to the database, best-effort. The tier ladder's
  // 7-day hold needs a NAV point on every calendar day; the recorder writes
  // JSONL that only reaches the database when someone runs `pnpm db:import`
  // by hand, which is exactly the kind of manual step that silently stops
  // happening. The pass runs anyway — one small insert makes promotion
  // evidence self-sustaining. Failure is swallowed: the database is optional
  // by design and a pass must never fail because history could not be saved.
  try {
    await recordNav(after.navUsd, "pass");
  } catch {
    // Ladder simply sees no new evidence; conservative by construction.
  }

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
