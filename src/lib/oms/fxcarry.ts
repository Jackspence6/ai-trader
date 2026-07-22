/**
 * FX carry accrual.
 *
 * A crypto perp pays funding you can read off the tape. Spot FX does not — the
 * carry is the interest-rate differential, and it accrues continuously for as
 * long as you hold the position. This module books that accrual as a
 * `FundingPayment`, the exact same mechanism crypto funding uses, so the forex
 * carry shows up in P&L through one code path rather than a special case.
 *
 * The direction matters and is easy to get wrong: holding the higher-yielding
 * currency earns the differential; holding the lower-yielding one pays it. A
 * long position in a pair earns `base_rate − quote_rate`; a short earns the
 * negation. On top of that the broker swap markup is charged **either way** — it
 * is a financing cost, not a spread — so a carry that has decayed can accrue
 * negative, which is honest rather than a bug.
 *
 * Accrual is time-based, so it must be driven once per elapsed interval by the
 * caller (the trading pass), which owns the "when did we last accrue" clock. A
 * pure function of (positions, rates, elapsed) keeps that testable.
 */

import { carryApr } from "@/lib/market/forex";
import { DEFAULT_SWAP_MARKUP_APR } from "@/lib/calc/fxsignal";
import { FX_VENUE } from "@/lib/market/fxbook";
import type { FxQuote } from "@/lib/market/forex";
import type { FundingPayment, Position } from "@/lib/portfolio/positions";

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** An open FX position, minimally — matches what `buildPositions` produces. */
type OpenFxPosition = Pick<Position, "asset" | "qty" | "sleeveId" | "venue">;

/**
 * Compute the carry accrued by every open FX position over `elapsedMs`.
 *
 * `now` and `elapsedMs` are injected so the caller controls the clock and the
 * function stays pure. A position priced at an unknown rate accrues nothing —
 * an accrual we cannot size honestly is not one we invent.
 */
export function accrueFxCarry(
  positions: OpenFxPosition[],
  quotes: FxQuote[],
  elapsedMs: number,
  now: number,
  opts: { swapMarkupApr?: number } = {},
): FundingPayment[] {
  if (elapsedMs <= 0) return [];
  const swap = opts.swapMarkupApr ?? DEFAULT_SWAP_MARKUP_APR;
  const years = elapsedMs / MS_PER_YEAR;
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));

  const out: FundingPayment[] = [];

  for (const p of positions) {
    if (p.venue !== FX_VENUE || p.qty === 0) continue;
    const q = bySymbol.get(p.asset);
    if (!q || !(q.rate > 0)) continue;

    // The differential in the direction actually held.
    const differential = carryApr(q.base, q.quote); // base_rate − quote_rate
    const signedDifferential = p.qty > 0 ? differential : -differential;
    // The swap markup is a cost regardless of direction.
    const netApr = signedDifferential - swap;

    const notionalUsd = Math.abs(p.qty) * q.rate;
    const amountUsd = netApr * notionalUsd * years;
    if (amountUsd === 0) continue;

    out.push({
      id: `fxcarry_${p.asset}_${now}`,
      ts: now,
      venue: FX_VENUE,
      asset: p.asset,
      amountUsd,
      sleeveId: p.sleeveId,
    });
  }

  return out;
}
