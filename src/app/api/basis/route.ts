/**
 * Cash-and-carry basis signals — spot vs quarterly future, scored live.
 *
 * Buy spot, short the dated future when it trades above spot, and collect the
 * basis, which converges to zero at expiry. Delta-neutral, deterministic at
 * settlement, and a different carry source from funding — see EXPANSION.md A2.
 *
 * Scored on real Binance data. Not yet wired into paper execution: a dated
 * future is a new instrument (its own expiry, no funding, its own mark), and
 * that goes into the order path deliberately rather than rushed. Until then this
 * surfaces the live opportunity so the edge can be watched and measured.
 */

import { fetchBasisQuotes, scoreBasis } from "@/lib/market/basis";
import { getNavUsd } from "@/lib/fund/nav";

export async function GET() {
  let quotes;
  try {
    quotes = await fetchBasisQuotes();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Basis feed unavailable", signals: [] },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  // Score at a representative leg size — a fifth of NAV, or a nominal $1k when
  // there is no capital yet, so the cost amortisation is realistic.
  const nav = await getNavUsd().catch(() => 0);
  const legNotionalUsd = nav > 0 ? Math.max(nav * 0.2, 100) : 1_000;

  const signals = scoreBasis(quotes, legNotionalUsd);
  const best = signals.filter((s) => s.result.viable)[0] ?? null;

  return Response.json(
    {
      legNotionalUsd,
      signals,
      best,
      viableCount: signals.filter((s) => s.result.viable).length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
