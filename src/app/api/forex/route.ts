/**
 * Live forex signals — the forex book's strategy, scored on real data.
 *
 * Fetches the current reference quotes and recent daily closes for every major
 * pair, then scores each for carry (F1) and trend (F2). Uncached: a stale carry
 * or trend read is a decision made on yesterday's market.
 *
 * This is honestly labelled reference data, not a live dealing feed — the quotes
 * are ECB daily fixes. Good enough to score signals and mark paper positions;
 * `stale` flags a weekend where the last fix is not a tradeable rate.
 */

import { FX_PAIRS, POLICY_RATES_AS_OF, fetchFxQuotes, fetchFxHistory } from "@/lib/market/forex";
import { scoreFxPair, type FxPairSignal } from "@/lib/calc/fxsignal";

export async function GET() {
  let quotes;
  try {
    quotes = await fetchFxQuotes();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "FX feed unavailable", signals: [] },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  // History per pair, fetched in parallel. A pair whose history fails still gets
  // a carry signal — trend simply reports it needs more data rather than failing
  // the whole response.
  const histories = await Promise.all(
    FX_PAIRS.map(async (p) => {
      try {
        const h = await fetchFxHistory(p.symbol, 120);
        return [p.symbol, h.map((d) => d.rate)] as const;
      } catch {
        return [p.symbol, [] as number[]] as const;
      }
    }),
  );
  const closesBySymbol = new Map(histories);

  const signals: FxPairSignal[] = quotes.map((q) =>
    scoreFxPair(q, closesBySymbol.get(q.symbol) ?? []),
  );

  // Surface the best carry and the strongest engaged trend up top so the UI can
  // lead with "what would the forex book do right now".
  const viableCarry = signals
    .filter((s) => s.carry.viable)
    .sort((a, b) => b.carry.netCarryApr - a.carry.netCarryApr);
  const engagedTrend = signals
    .filter((s) => s.trend.engaged)
    .sort((a, b) => Math.abs(b.trend.strengthPct) - Math.abs(a.trend.strengthPct));

  return Response.json(
    {
      asOf: quotes[0]?.asOfDate ?? null,
      policyRatesAsOf: POLICY_RATES_AS_OF,
      signals,
      bestCarry: viableCarry[0] ?? null,
      bestTrend: engagedTrend[0] ?? null,
      viableCarryCount: viableCarry.length,
      engagedTrendCount: engagedTrend.length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
