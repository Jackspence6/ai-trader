/**
 * Position sizing.
 *
 * Sizing decides survival; entry signals only decide the rate of progress. A
 * mediocre signal sized correctly compounds slowly. An excellent signal sized
 * badly is eventually ruined by a single bad week, and "eventually" arrives
 * sooner than intuition suggests.
 *
 * Three sizing models live here, used in different places:
 *   - `volatilityTargetSize` for directional positions (H1 trend, H2 pairs)
 *   - `riskUnitSize` where an explicit invalidation level exists
 *   - `fractionalKelly` as a *cap*, never as the primary sizer
 */

/**
 * Size a position so its expected annualised volatility contribution equals a
 * target fraction of NAV.
 *
 *   notional = NAV × targetVol / assetVol
 *
 * This is the sizing method that makes a multi-asset book coherent. Without it,
 * an equal-dollar SOL position carries roughly twice the risk of an equal-dollar
 * BTC position, so the book's actual risk profile is an accident of which
 * symbols happen to be in it rather than a decision anyone made.
 *
 * `maxFraction` caps any single position regardless of how quiet the asset
 * looks. Low measured volatility is often a *precursor* to high volatility, not
 * a guarantee of calm, and an uncapped vol-target sizer will happily build an
 * enormous position right before that resolves.
 */
export function volatilityTargetSize(
  navUsd: number,
  targetAnnualVol: number,
  assetAnnualVol: number,
  maxFraction = 0.25,
): number {
  if (navUsd <= 0 || assetAnnualVol <= 0) return 0;
  const raw = (navUsd * targetAnnualVol) / assetAnnualVol;
  return Math.min(raw, navUsd * maxFraction);
}

/**
 * Size from a fixed risk budget and a known invalidation distance.
 *
 *   notional = (NAV × riskPerTrade) / stopDistanceFraction
 *
 * Used wherever a stop is meaningful — typically an ATR multiple. The result is
 * that every directional trade loses the same amount of money when it is wrong,
 * which is what makes a hit rate interpretable at all.
 */
export function riskUnitSize(
  navUsd: number,
  riskPerTradeFraction: number,
  stopDistanceFraction: number,
  maxFraction = 0.25,
): number {
  if (navUsd <= 0 || stopDistanceFraction <= 0) return 0;
  const raw = (navUsd * riskPerTradeFraction) / stopDistanceFraction;
  return Math.min(raw, navUsd * maxFraction);
}

/**
 * Stop distance as a fraction of price, from an ATR reading.
 *
 * A 2.5–3x ATR stop is the usual band for crypto daily bars: tight enough to
 * cap the loss, wide enough that ordinary noise doesn't trigger it. Tighter
 * stops do not reduce risk — they convert it into a higher frequency of small
 * losses plus the fees to match.
 */
export function atrStopDistance(atrValue: number, price: number, multiple = 2.5): number {
  if (price <= 0 || atrValue <= 0) return 0;
  return (atrValue * multiple) / price;
}

/**
 * Kelly fraction for a binary-outcome bet.
 *
 *   f* = p − (1 − p) / (win/loss ratio)
 *
 * **Full Kelly is not usable here** and the code refuses to return it. Kelly
 * assumes the edge is known exactly; ours is estimated from a small sample and
 * will be overstated. Full Kelly on an overestimated edge is an overbet, and
 * Kelly's own drawdown profile is brutal even when the edge is exactly right —
 * a 50% drawdown is an ordinary event at full Kelly.
 *
 * So this returns a *fraction* of Kelly (default one quarter), which is the
 * conventional compromise: roughly 90% of the growth rate at a fraction of the
 * drawdown. Negative results clamp to zero — a negative Kelly means don't trade,
 * not trade the other way, because the costs are the same in both directions.
 */
export function fractionalKelly(
  winProbability: number,
  winLossRatio: number,
  fraction = 0.25,
): number {
  if (winLossRatio <= 0) return 0;
  const p = Math.min(Math.max(winProbability, 0), 1);
  const full = p - (1 - p) / winLossRatio;
  return Math.max(full, 0) * fraction;
}

/**
 * Scale a size down toward zero as a limit is approached, rather than allowing
 * full size right up to a hard cliff.
 *
 * Hard limits produce a bad failure mode: the system trades at full size until
 * it hits the cap, then stops dead. A taper means risk consumption degrades
 * gracefully, and the last increment of a limit is never spent on a marginal
 * opportunity.
 */
export function taperToLimit(
  desiredUsd: number,
  currentUsageUsd: number,
  limitUsd: number,
  taperStart = 0.7,
): number {
  if (limitUsd <= 0) return 0;
  const headroom = limitUsd - currentUsageUsd;
  if (headroom <= 0) return 0;

  const usage = currentUsageUsd / limitUsd;
  const capped = Math.min(desiredUsd, headroom);
  if (usage <= taperStart) return capped;

  // Linear taper from full size at `taperStart` to zero at the limit.
  const scale = (1 - usage) / (1 - taperStart);
  return capped * Math.max(scale, 0);
}

/**
 * Round a notional down to a venue's lot/step size and verify it still clears
 * the minimum notional. Returns 0 if it doesn't.
 *
 * Rounding *down* is deliberate: rounding up silently breaches whatever limit
 * produced the size in the first place.
 */
export function quantiseNotional(
  notionalUsd: number,
  price: number,
  stepSize: number,
  minNotionalUsd: number,
): { qty: number; notionalUsd: number } {
  if (price <= 0 || stepSize <= 0) return { qty: 0, notionalUsd: 0 };
  const rawQty = notionalUsd / price;
  const steps = Math.floor(rawQty / stepSize);
  const qty = steps * stepSize;
  const actual = qty * price;
  if (actual < minNotionalUsd) return { qty: 0, notionalUsd: 0 };
  return { qty, notionalUsd: actual };
}
