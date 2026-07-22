/**
 * Crypto perp funding accrual.
 *
 * The paper book could open funding-carry positions but never booked the
 * funding itself — the one income stream the strategy exists to harvest. FX
 * carry accrued (fxcarry.ts) while a crypto carry's `fundingUsd` stayed zero
 * forever, so paper P&L on the core strategy was fees and mark noise with the
 * revenue missing. This module is the crypto half of the same mechanism.
 *
 * Accrual is continuous against the annualised funding rate rather than
 * discretised to the venue's 8h/1h payment schedule. Over the multi-day holds
 * carry targets, the difference is sub-bp; what matters is that income accrues
 * at the rate actually observed, in the direction actually held: a short perp
 * under positive funding receives, a long pays, and both flip when funding
 * inverts.
 *
 * Same contract as `accrueFxCarry`: pure function of (positions, rates,
 * elapsed); the trading pass owns the clock. A position whose funding rate or
 * mark price is unknown accrues nothing — an accrual we cannot size honestly
 * is not one we invent.
 */

import { FX_VENUE } from "@/lib/market/fxbook";
import type { FundingPayment, Position } from "@/lib/portfolio/positions";

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** An open position, minimally — matches what `buildPositions` produces. */
type OpenPosition = Pick<Position, "asset" | "qty" | "sleeveId" | "venue" | "market">;

export function accruePerpFunding(
  positions: OpenPosition[],
  /** Current annualised funding for a perp, by venue and asset. */
  fundingApr: (venue: string, asset: string) => number | undefined,
  /** Current mark price per asset, USD. */
  price: (asset: string) => number | undefined,
  elapsedMs: number,
  now: number,
): FundingPayment[] {
  if (elapsedMs <= 0) return [];
  const years = elapsedMs / MS_PER_YEAR;

  const out: FundingPayment[] = [];

  for (const p of positions) {
    if (p.market !== "perp" || p.venue === FX_VENUE || p.qty === 0) continue;

    const apr = fundingApr(String(p.venue), p.asset);
    const mark = price(p.asset);
    if (apr === undefined || mark === undefined || !(mark > 0)) continue;

    // Longs pay funding when positive, shorts receive it — so the sign of the
    // payment is opposite to the sign of the position.
    const amountUsd = -p.qty * mark * apr * years;
    if (amountUsd === 0) continue;

    out.push({
      id: `perpfunding_${p.venue}_${p.asset}_${now}`,
      ts: now,
      venue: p.venue,
      asset: p.asset,
      amountUsd,
      sleeveId: p.sleeveId,
    });
  }

  return out;
}
