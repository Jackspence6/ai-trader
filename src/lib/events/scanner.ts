// Serverless Polymarket scanner: Gamma discovery -> CLOB books + live fee rates
// -> fee-aware PM-internal arb detection -> Neon.
//
// Detects exactly the two Polymarket-internal arb types from spec §5 that need no
// bookmaker leg (and therefore no endpoint discovery), so the hosted deployment is
// useful on day one:
//   (1) binary YES+NO acquisition cost < $1 after taker fees
//   (2) negRisk COMPLETE outcome set summing to < $1 after fees
//
// Phase 1 remains measurement-first: this records and alerts, it never trades.

import { createHash } from "node:crypto";
import {
  balancedStakes, depthCapacityUsd, effectiveBuyPrice, effectiveDecimalOdds,
  margin as arbMargin, naturalizeStakes,
} from "./arb";
import { scoreOpportunity } from "./scoring";
import {
  bestAsk, fetchBook, fetchEvents, fetchFeeRate, feeRateForCategory,
  parseGammaMarket, type ParsedBook, type ParsedMarket,
} from "./polymarket";
import { detectConsistencyArb, findNestedPairs } from "./consistency";
import { q } from "./db";
import { sendAlert, type AlertOpportunity } from "./telegram";

export const DEFAULT_TAGS = (process.env.POLYMARKET_TAGS ?? "sports,nba,nfl,soccer,epl,tennis,crypto,politics")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MIN_MARGIN_PCT = Number(process.env.SCAN_MIN_MARGIN_PCT ?? 0.5);
const MIN_EXECUTABLE_ZAR = Number(process.env.SCAN_MIN_EXECUTABLE_ZAR ?? 2000);
const SLIPPAGE_BPS = Number(process.env.SCAN_SLIPPAGE_BPS ?? 50);
const FX_BUFFER_PCT = Number(process.env.FX_BUFFER_PCT ?? 2);
const TOTAL_STAKE_ZAR = Number(process.env.SCAN_TOTAL_STAKE_ZAR ?? 10000);
const ALERT_MIN_MARGIN_PCT = Number(process.env.ALERT_MIN_MARGIN_PCT ?? 1.0);
const ALERT_MIN_EXECUTABLE_ZAR = Number(process.env.ALERT_MIN_EXECUTABLE_ZAR ?? 2000);
const ALERT_IMPROVEMENT_PP = Number(process.env.ALERT_IMPROVEMENT_PP ?? 0.5);

export function oppId(eventId: string, marketKey: string, legs: [string, string][]): string {
  const blob = `${eventId}|${marketKey}|` +
    legs.map(([v, o]) => `${v}:${o}`).sort().join("|");
  return createHash("sha1").update(blob).digest("hex").slice(0, 12);
}

async function fetchFxUsdZar(): Promise<{ mid: number; buffered: number; live: boolean }> {
  const fallback = Number(process.env.FX_FALLBACK_USDZAR ?? 18);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(process.env.FX_PROVIDER_URL ?? "https://open.er-api.com/v6/latest/USD",
      { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    const mid = Number(data?.rates?.ZAR);
    if (Number.isFinite(mid) && mid > 0) {
      return { mid, buffered: mid / (1 + FX_BUFFER_PCT / 100), live: true };
    }
  } catch { /* keep fallback — an FX outage must not stop measurement */ }
  return { mid: fallback, buffered: fallback / (1 + FX_BUFFER_PCT / 100), live: false };
}

interface Candidate {
  id: string;
  marketKey: string;
  eventId: string;
  eventLabel: string;
  league: string | null;
  isNegRisk: boolean;
  endDate: string | null;
  marginPct: number;
  /** Nested-bracket arbs depend on two resolution texts agreeing about containment,
   *  which only the operator can confirm — they are never "clean". */
  ruleRisk?: boolean;
  extraNotes?: string[];
  legs: {
    tokenId: string; label: string; price: number; feeRate: number;
    oddsEff: number; depthUsd: number; outcome: string;
  }[];
}

/** Binary market: buy 1 YES + 1 NO. Pays exactly 1 → arb iff fee-inclusive cost < 1. */
function binaryCandidate(
  pm: ParsedMarket, books: Map<string, ParsedBook | null>, feeRate: number,
): Candidate | null {
  if (pm.tokenIds.length !== 2) return null;
  const [tYes, tNo] = pm.tokenIds;
  const aYes = bestAsk(books.get(tYes) ?? null);
  const aNo = bestAsk(books.get(tNo) ?? null);
  if (aYes == null || aNo == null) return null;
  if (aYes <= 0 || aYes >= 1 || aNo <= 0 || aNo >= 1) return null;

  const cost = effectiveBuyPrice(aYes, feeRate) + effectiveBuyPrice(aNo, feeRate);
  const marginPct = (1 - cost) * 100;
  if (marginPct < MIN_MARGIN_PCT) return null;

  const mk = `BINARY_YESNO||q:${pm.conditionId}`;
  const eventId = pm.eventId ?? pm.conditionId;
  return {
    id: oppId(eventId, mk, [["polymarket", "YES"], ["polymarket", "NO"]]),
    marketKey: mk, eventId, eventLabel: pm.question || pm.eventTitle || pm.slug,
    league: pm.category, isNegRisk: false, endDate: pm.endDate, marginPct,
    legs: [
      { tokenId: tYes, label: `${pm.outcomes[0] ?? "Yes"}`, price: aYes, feeRate,
        oddsEff: effectiveDecimalOdds(aYes, feeRate), outcome: "YES",
        depthUsd: depthCapacityUsd(books.get(tYes)?.asks ?? [], aYes, feeRate, SLIPPAGE_BPS) },
      { tokenId: tNo, label: `${pm.outcomes[1] ?? "No"}`, price: aNo, feeRate,
        oddsEff: effectiveDecimalOdds(aNo, feeRate), outcome: "NO",
        depthUsd: depthCapacityUsd(books.get(tNo)?.asks ?? [], aNo, feeRate, SLIPPAGE_BPS) },
    ],
  };
}

/** negRisk: exactly one outcome resolves YES, so a COMPLETE set pays 1.
 *  Only run when every member market of the event is present and priced —
 *  a partial set produces a phantom arb. */
function negRiskCandidate(
  event: Record<string, unknown>, markets: ParsedMarket[],
  books: Map<string, ParsedBook | null>, feeByToken: Map<string, number>,
): Candidate | null {
  if (markets.length < 2) return null;
  const legs: Candidate["legs"] = [];
  for (const pm of markets) {
    const yesToken = pm.tokenIds[0];
    const ask = bestAsk(books.get(yesToken) ?? null);
    const fee = feeByToken.get(yesToken);
    if (ask == null || fee == null || ask <= 0 || ask >= 1) return null; // incomplete set
    legs.push({
      tokenId: yesToken, label: `${pm.question || pm.outcomes[0] || "Yes"}`, price: ask,
      feeRate: fee, oddsEff: effectiveDecimalOdds(ask, fee), outcome: `OUT:${pm.conditionId}`,
      depthUsd: depthCapacityUsd(books.get(yesToken)?.asks ?? [], ask, fee, SLIPPAGE_BPS),
    });
  }
  const cost = legs.reduce((acc, l) => acc + effectiveBuyPrice(l.price, l.feeRate), 0);
  const marginPct = (1 - cost) * 100;
  if (marginPct < MIN_MARGIN_PCT) return null;

  const eventId = String(event.id ?? markets[0].conditionId);
  const mk = `NEGRISK_MULTI||q:${eventId}`;
  return {
    id: oppId(eventId, mk, legs.map((l) => ["polymarket", l.outcome] as [string, string])),
    marketKey: mk, eventId,
    eventLabel: String(event.title ?? markets[0].question),
    league: markets[0].category, isNegRisk: true,
    endDate: markets[0].endDate, marginPct, legs,
  };
}

export interface ScanResult {
  scanned_markets: number;
  scanned_events: number;
  candidates: number;
  written: number;
  expired: number;
  fx: { mid: number; buffered: number; live: boolean };
  errors: string[];
  alerts_sent: number;
  alerts_dry_run: number;
  opportunities: { id: string; event: string; margin_pct: number; score: number; type: string }[];
  duration_ms: number;
}

/** Whether an opportunity warrants an alert now: newly seen (or returning from
 *  expiry), or materially better than its own previous peak. Mirrors the engine's
 *  rule in services/engine.py so the two never disagree about what's worth a ping. */
function alertKind(
  prev: { state: string; peak_margin_pct: number } | undefined, marginPct: number,
): "new" | "improved" | null {
  if (!prev || prev.state !== "active") return "new";
  if (marginPct >= Number(prev.peak_margin_pct) + ALERT_IMPROVEMENT_PP) return "improved";
  return null;
}

export async function scan(opts: { tags?: string[]; maxMarkets?: number; persist?: boolean } = {}): Promise<ScanResult> {
  const started = Date.now();
  const tags = opts.tags ?? DEFAULT_TAGS;
  const maxMarkets = opts.maxMarkets ?? Number(process.env.SCAN_MAX_MARKETS ?? 120);
  const persist = opts.persist ?? true;
  const errors: string[] = [];

  const fx = await fetchFxUsdZar();

  // --- discovery -----------------------------------------------------------
  const eventsById = new Map<string, Record<string, unknown>>();
  const marketsByEvent = new Map<string, ParsedMarket[]>();
  let scannedMarkets = 0;

  for (const tag of tags) {
    if (scannedMarkets >= maxMarkets) break;
    let events: Record<string, unknown>[];
    try {
      events = await fetchEvents(tag, 30);
    } catch (err) {
      errors.push(`gamma ${tag}: ${(err as Error).message}`);
      continue;
    }
    for (const ev of events) {
      const evId = String(ev.id ?? "");
      if (!evId || eventsById.has(evId)) continue;
      const raw = (ev.markets as Record<string, unknown>[]) ?? [];
      const parsed = raw.map((m) => parseGammaMarket(m, ev)).filter((m): m is ParsedMarket => m != null && !m.closed);
      if (!parsed.length) continue;
      if (scannedMarkets + parsed.length > maxMarkets) continue;
      eventsById.set(evId, ev);
      marketsByEvent.set(evId, parsed);
      scannedMarkets += parsed.length;
    }
  }

  // --- books + live fee rates ---------------------------------------------
  const books = new Map<string, ParsedBook | null>();
  const feeByToken = new Map<string, number>();
  const allMarkets = [...marketsByEvent.values()].flat();

  const CONCURRENCY = 8;
  const tokenJobs: { token: string; pm: ParsedMarket }[] = [];
  for (const pm of allMarkets) for (const t of pm.tokenIds) tokenJobs.push({ token: t, pm });

  for (let i = 0; i < tokenJobs.length; i += CONCURRENCY) {
    const slice = tokenJobs.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async ({ token, pm }) => {
      const [book, fee] = await Promise.all([
        fetchBook(token),
        fetchFeeRate(token, feeRateForCategory(pm.category)),
      ]);
      books.set(token, book);
      feeByToken.set(token, fee);
    }));
  }

  // --- detection -----------------------------------------------------------
  const candidates: Candidate[] = [];
  for (const [evId, markets] of marketsByEvent) {
    const ev = eventsById.get(evId)!;
    for (const pm of markets) {
      const fee = feeByToken.get(pm.tokenIds[0]) ?? feeRateForCategory(pm.category);
      const c = binaryCandidate(pm, books, fee);
      if (c) candidates.push(c);
    }
    const negRiskMarkets = markets.filter((m) => m.negRisk);
    if (negRiskMarkets.length >= 2 && negRiskMarkets.length === markets.length) {
      const c = negRiskCandidate(ev, negRiskMarkets, books, feeByToken);
      if (c) candidates.push(c);
    }

    // Logical-consistency arbs across nested brackets (spec §5 type 3).
    for (const pair of findNestedPairs(markets)) {
      const hit = detectConsistencyArb(pair, books, feeByToken, MIN_MARGIN_PCT);
      if (!hit) continue;
      const mk = `CONSISTENCY||q:${pair.inner.conditionId}+${pair.outer.conditionId}`;
      const eventId = String(ev.id ?? pair.inner.conditionId);
      candidates.push({
        id: oppId(eventId, mk, [["polymarket", "NO_INNER"], ["polymarket", "YES_OUTER"]]),
        marketKey: mk, eventId,
        eventLabel: `${pair.inner.question}  ⊂  ${pair.outer.question}`,
        league: pair.inner.category, isNegRisk: false,
        endDate: pair.outer.endDate, marginPct: hit.marginPct,
        ruleRisk: true,
        extraNotes: [
          pair.explanation,
          "Worst case pays 1; if the event lands between the two brackets both legs win (pays 2).",
          "CONFIRM both resolution texts describe the same event before placing — the edge depends on it.",
        ],
        legs: [
          {
            tokenId: hit.innerNoToken, label: `NO — ${pair.inner.question}`,
            price: hit.innerNoPrice, feeRate: hit.innerFeeRate,
            oddsEff: effectiveDecimalOdds(hit.innerNoPrice, hit.innerFeeRate), outcome: "NO_INNER",
            depthUsd: depthCapacityUsd(books.get(hit.innerNoToken)?.asks ?? [], hit.innerNoPrice,
                                       hit.innerFeeRate, SLIPPAGE_BPS),
          },
          {
            tokenId: hit.outerYesToken, label: `YES — ${pair.outer.question}`,
            price: hit.outerYesPrice, feeRate: hit.outerFeeRate,
            oddsEff: effectiveDecimalOdds(hit.outerYesPrice, hit.outerFeeRate), outcome: "YES_OUTER",
            depthUsd: depthCapacityUsd(books.get(hit.outerYesToken)?.asks ?? [], hit.outerYesPrice,
                                       hit.outerFeeRate, SLIPPAGE_BPS),
          },
        ],
      });
    }
  }

  // --- size, score, persist -----------------------------------------------
  const nowIso = new Date().toISOString();
  const written: ScanResult["opportunities"] = [];
  let alertsSent = 0;
  let alertsDryRun = 0;

  // The kill switch lives in the shared database so it reaches every worker.
  let killSwitch = false;
  if (persist) {
    try {
      const rows = await q<{ value: unknown }>("SELECT value FROM runtime_flags WHERE key='kill_switch'");
      killSwitch = rows[0]?.value === true || rows[0]?.value === "true";
    } catch { /* flag table may predate migration 004 — treat as off */ }
  }

  for (const c of candidates) {
    const odds = c.legs.map((l) => l.oddsEff);
    const pEff = c.legs.map((l) => effectiveBuyPrice(l.price, l.feeRate));
    const setCostUsd = pEff.reduce((a, b) => a + b, 0);

    // Locking the arb means buying the SAME share count N of every outcome; the
    // set pays exactly $1, so profit = N * (1 - setCost). Depth on the thinnest
    // leg is what binds N.
    const maxSharesPerLeg = c.legs.map((l, i) => (l.depthUsd > 0 ? l.depthUsd / pEff[i] : 0));
    const nShares = Math.min(...maxSharesPerLeg);
    const fullCostZar = nShares * setCostUsd * fx.buffered;

    // Executable size per leg = each leg's stake at the largest fully-backed total.
    const executableZarPerLeg = fullCostZar > 0
      ? Math.min(...balancedStakes(fullCostZar, odds))
      : 0;

    // The plan the operator actually places is capped by the configured bankroll.
    const plan = naturalizeStakes(Math.max(Math.min(TOTAL_STAKE_ZAR, fullCostZar), 100), odds);

    const daysToEnd = c.endDate ? (new Date(c.endDate).getTime() - Date.now()) / 86_400_000 : null;
    const { score, breakdown } = scoreOpportunity({
      marginPct: c.marginPct,
      executableZarPerLeg,
      minExecutableZar: MIN_EXECUTABLE_ZAR,
      predictedWindowS: 300,
      legSoftness: c.legs.map(() => 0.1), // Polymarket is the sharp venue
      stakesNatural: plan.natural,
      ruleRisk: Boolean(c.ruleRisk),
      hasPmLeg: true, isNegRisk: c.isNegRisk, isInternal: true,
      isLive: daysToEnd != null && daysToEnd <= 0,
      mainstreamLeague: false,
    });

    written.push({
      id: c.id, event: c.eventLabel, margin_pct: Number(c.marginPct.toFixed(3)),
      score, type: "polymarket_internal",
    });

    if (!persist) continue;
    let prev: { state: string; peak_margin_pct: number } | undefined;
    try {
      const rows = await q<{ state: string; peak_margin_pct: number }>(
        "SELECT state, peak_margin_pct FROM opportunities WHERE id=$1", [c.id]);
      prev = rows[0];
    } catch { /* first run, before the table exists */ }

    try {
      await q(
        `INSERT INTO opportunities
           (id, opp_type, event_id, event_label, sport, league, start_time, market_key,
            margin_pct, score, score_breakdown, urgency, timing, rule_risk, mirrored,
            total_stake_zar, guaranteed_profit_zar, executable_zar_per_leg, fx_rate,
            first_seen, last_seen, peak_margin_pct, state, window_s, notes)
         VALUES ($1,'polymarket_internal',$2,$3,'other',$4,$5,$6,$7,$8,$9,'low','pre_match',
                 $16,false,$10,$11,$12,$13,$14,$14,$7,'active',NULL,$15)
         ON CONFLICT (id) DO UPDATE SET
           margin_pct=EXCLUDED.margin_pct, score=EXCLUDED.score,
           score_breakdown=EXCLUDED.score_breakdown, last_seen=EXCLUDED.last_seen,
           peak_margin_pct=GREATEST(opportunities.peak_margin_pct, EXCLUDED.margin_pct),
           state='active', window_s=NULL,
           total_stake_zar=EXCLUDED.total_stake_zar,
           guaranteed_profit_zar=EXCLUDED.guaranteed_profit_zar,
           executable_zar_per_leg=EXCLUDED.executable_zar_per_leg`,
        [c.id, c.eventId, c.eventLabel, c.league, c.endDate, c.marketKey,
         Number(c.marginPct.toFixed(3)), score, JSON.stringify(breakdown),
         Number(plan.total.toFixed(2)), Number(plan.worstProfit.toFixed(2)),
         Number(executableZarPerLeg.toFixed(2)), Number(fx.buffered.toFixed(4)), nowIso,
         JSON.stringify([
           ...(c.extraNotes ?? [`Polymarket-internal: buy every outcome, set pays exactly $1.`]),
           `Fees applied per leg at the live /fee-rate; FX buffered @ ${fx.buffered.toFixed(2)} USDZAR.`,
         ]),
         Boolean(c.ruleRisk)],
      );
      await q(`DELETE FROM opportunity_legs WHERE opportunity_id=$1`, [c.id]);
      for (let i = 0; i < c.legs.length; i++) {
        const l = c.legs[i];
        await q(
          `INSERT INTO opportunity_legs
             (opportunity_id, idx, venue_id, outcome, selection_label, odds, raw_price,
              fee_rate, stake_zar, deep_link, rules_group, is_pm, token_id, max_stake_zar, order_index)
           VALUES ($1,$2,'polymarket',$3,$4,$5,$6,$7,$8,$9,$13,true,$10,$11,$12)`,
          [c.id, i, l.outcome, l.label, l.oddsEff, l.price, l.feeRate,
           Number((plan.stakes[i] ?? 0).toFixed(2)),
           `https://polymarket.com/event/${encodeURIComponent(c.eventId)}`,
           l.tokenId, Number((l.depthUsd * fx.buffered).toFixed(2)), i + 1,
           c.ruleRisk ? "UNVERIFIED" : "DEFAULT"],
        );
        await q(
          `INSERT INTO odds_snapshots
             (ts, ts_source, venue_id, event_id, market_key, outcome, decimal_odds,
              raw_price, fee_rate, status, executable_zar, token_id)
           VALUES (now(), now(), 'polymarket',$1,$2,$3,$4,$5,$6,'active',$7,$8)`,
          [c.eventId, c.marketKey, l.outcome, l.oddsEff, l.price, l.feeRate,
           Number((l.depthUsd * fx.buffered).toFixed(2)), l.tokenId],
        );
      }

      const kind = alertKind(prev, c.marginPct);
      const worthAlerting =
        kind !== null &&
        c.marginPct >= ALERT_MIN_MARGIN_PCT &&
        executableZarPerLeg >= ALERT_MIN_EXECUTABLE_ZAR;

      if (worthAlerting && killSwitch) {
        errors.push(`alert suppressed by kill switch: ${c.id}`);
      } else if (worthAlerting) {
        const alert: AlertOpportunity = {
          id: c.id, eventLabel: c.eventLabel, sport: "polymarket", league: c.league,
          startTime: c.endDate, marketType: c.isNegRisk ? "NEGRISK_MULTI" : "BINARY_YESNO",
          legs: c.legs.map((l, i) => ({
            venueName: "Polymarket", selectionLabel: l.label, odds: l.oddsEff,
            stakeZar: plan.stakes[i] ?? 0, orderIndex: i + 1,
            rawPrice: l.price, feeRate: l.feeRate,
          })),
          marginPct: c.marginPct, executableZarPerLeg, guaranteedProfitZar: plan.worstProfit,
          totalStakeZar: plan.total, score, urgency: "low",
          ruleRisk: Boolean(c.ruleRisk),
          ruleRiskNote: c.ruleRisk ? "nested brackets — confirm both resolution texts" : null,
          fxRate: fx.buffered,
          notes: [
            kind === "improved" ? "Margin improved since the last alert." : "",
            ...(c.extraNotes ?? ["Polymarket-internal: buy every outcome; the set pays exactly $1."]),
          ].filter(Boolean),
        };
        const res = await sendAlert(alert);
        if (res.ok && res.dryRun) alertsDryRun++;
        else if (res.ok) alertsSent++;
        else errors.push(`alert ${c.id}: ${res.error}`);

        try {
          await q(
            `INSERT INTO alerts(opportunity_id, channel, kind, ok, dry_run, payload)
             VALUES ($1,'telegram',$2,$3,$4,$5::jsonb)`,
            [c.id, kind, res.ok, res.dryRun, JSON.stringify({ margin_pct: c.marginPct, score })],
          );
        } catch { /* alert log is best-effort */ }
      }
    } catch (err) {
      errors.push(`persist ${c.id}: ${(err as Error).message}`);
    }
  }

  // --- expire anything this scan no longer sees ----------------------------
  let expired = 0;
  if (persist) {
    try {
      const ids = written.map((w) => w.id);
      const rows = await q<{ id: string }>(
        `UPDATE opportunities
            SET state='expired',
                window_s = EXTRACT(EPOCH FROM (now() - first_seen))
          WHERE opp_type='polymarket_internal'
            AND state='active'
            AND NOT (id = ANY($1::text[]))
          RETURNING id`,
        [ids],
      );
      expired = rows.length;
    } catch (err) {
      errors.push(`expire: ${(err as Error).message}`);
    }
  }

  return {
    scanned_markets: scannedMarkets,
    scanned_events: eventsById.size,
    candidates: candidates.length,
    written: written.length,
    expired,
    fx,
    errors,
    alerts_sent: alertsSent,
    alerts_dry_run: alertsDryRun,
    opportunities: written.sort((a, b) => b.score - a.score).slice(0, 25),
    duration_ms: Date.now() - started,
  };
}
