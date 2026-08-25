// Promo & bonus-rollover hedging math — TypeScript port of
// backend/oddsengine/promos.py, kept in lockstep by scripts/check-arb-parity.mjs.
//
// The spec's own benchmark: if manual capture rate on live arbs lands under 30%,
// this becomes the primary edge, because a rollover deadline is measured in weeks
// while a cross-platform arb window is measured in seconds.

import { effectiveDecimalOdds } from "./arb";

export type BonusKind = "cash" | "free_bet";

export interface Promo {
  id: string;
  venueId: string;
  name: string;
  bonusZar: number;
  rolloverMultiple: number;
  minOdds: number;
  kind: BonusKind;
  /** Deposit that unlocks the full bonus. Non-zero means a match that scales pro
   *  rata below the cap — the difference between "R20,000 bonus" and "R20,000
   *  bonus if you have R20,000". */
  depositRequiredZar?: number;
  deadlineDays?: number | null;
  onePerHousehold: boolean;
  termsNote: string;
}

/** Overround above which a (back, hedge) pair almost certainly isn't a true
 *  complement — e.g. two prices for the same side. Real two-way markets sit
 *  near 1.02–1.08. */
export const IMPLAUSIBLE_OVERROUND = 1.15;

export function pairOverround(backOdds: number, hedgeOdds: number): number {
  return 1 / backOdds + 1 / hedgeOdds;
}

/** L = 1 + b/h - b: the fraction of each back stake burned to hedge it.
 *  hedgeOdds are the odds of the OPPOSITE outcome. */
export function qualifyingLossRate(backOdds: number, hedgeOdds: number): number {
  if (backOdds <= 1 || hedgeOdds <= 1) throw new Error("decimal odds must be > 1");
  return 1 + backOdds / hedgeOdds - backOdds;
}

export interface HedgePlan {
  backOdds: number;
  hedgeOdds: number;
  backStakeZar: number;
  hedgeStakeZar: number;
  totalOutlayZar: number;
  guaranteedReturnZar: number;
  lossZar: number;
  lossRate: number;
}

export function planHedge(backOdds: number, hedgeOdds: number, backStakeZar: number): HedgePlan {
  if (backStakeZar <= 0) throw new Error("back stake must be positive");
  const hedgeStakeZar = (backStakeZar * backOdds) / hedgeOdds;
  const guaranteedReturnZar = backStakeZar * backOdds;
  const totalOutlayZar = backStakeZar + hedgeStakeZar;
  const lossZar = totalOutlayZar - guaranteedReturnZar;
  return {
    backOdds, hedgeOdds, backStakeZar, hedgeStakeZar, totalOutlayZar,
    guaranteedReturnZar, lossZar, lossRate: lossZar / backStakeZar,
  };
}

/** Hedge a bookmaker qualifying bet against a fee-aware Polymarket leg. */
export function planHedgeOnPolymarket(
  backOdds: number, pmPrice: number, pmFeeRate: number, backStakeZar: number,
): HedgePlan & { hedgePrice: number; hedgeFeeRate: number } {
  const hedgeOdds = effectiveDecimalOdds(pmPrice, pmFeeRate);
  return { ...planHedge(backOdds, hedgeOdds, backStakeZar), hedgePrice: pmPrice, hedgeFeeRate: pmFeeRate };
}

/** Free bet (stake not returned): retained = F*(b-1)*(h-1)/h. */
export function freeBetValue(faceValueZar: number, odds: number, hedgeOdds: number): number {
  if (odds <= 1 || hedgeOdds <= 1) throw new Error("decimal odds must be > 1");
  const hedgeStake = (faceValueZar * (odds - 1)) / hedgeOdds;
  return hedgeStake * (hedgeOdds - 1);
}

export interface PromoEV {
  promoId: string;
  venueId: string;
  bonusZar: number;
  requiredTurnoverZar: number;
  lossRate: number;
  cycles: number;
  cycleStakeZar: number;
  totalHedgingCostZar: number;
  expectedValueZar: number;
  evPerDay: number | null;
  breakEvenLossRate: number;
  viable: boolean;
  warnings: string[];
}

export function evaluatePromo(
  promo: Promo, backOdds: number, hedgeOdds: number, cycleStakeZar?: number,
): PromoEV {
  const warnings: string[] = [];
  if (backOdds < promo.minOdds) {
    warnings.push(
      `back odds ${backOdds.toFixed(2)} are below the promo's minimum ${promo.minOdds.toFixed(2)} — these bets would not count toward rollover`,
    );
  }
  const lossRate = qualifyingLossRate(backOdds, hedgeOdds);
  const overround = pairOverround(backOdds, hedgeOdds);
  if (overround > IMPLAUSIBLE_OVERROUND) {
    warnings.push(
      `back ${backOdds.toFixed(2)} / hedge ${hedgeOdds.toFixed(2)} implies a ${Math.round((overround - 1) * 100)}% overround — check the hedge is the OPPOSITE outcome, not the same side`,
    );
  }

  const turnover = promo.bonusZar * promo.rolloverMultiple;
  const stake = cycleStakeZar ?? Math.max(turnover / 10, 50);
  const cycles = Math.max(1, Math.round(turnover / stake));
  const hedgingCost = turnover * lossRate;

  let realisableBonus = promo.bonusZar;
  if (promo.kind === "free_bet") {
    realisableBonus = freeBetValue(promo.bonusZar, backOdds, hedgeOdds);
    warnings.push("free bet: stake is not returned, so face value overstates the edge");
  }

  const ev = realisableBonus - hedgingCost;
  const breakEven = promo.rolloverMultiple ? 1 / promo.rolloverMultiple : Infinity;

  let evPerDay: number | null = null;
  if (promo.deadlineDays) {
    evPerDay = ev / promo.deadlineDays;
    const requiredDaily = turnover / promo.deadlineDays;
    if (requiredDaily > 5000) {
      warnings.push(
        `clearing this needs R${Math.round(requiredDaily).toLocaleString()}/day of turnover — that pace is itself an account-safety signal`,
      );
    }
  }
  if (promo.onePerHousehold) {
    warnings.push("one bonus per person/household/IP — one genuine account only");
  }
  if (lossRate >= breakEven) {
    warnings.push(
      `loss rate ${(lossRate * 100).toFixed(1)}% exceeds the ${(breakEven * 100).toFixed(1)}% break-even for a ${promo.rolloverMultiple}x rollover`,
    );
  }

  return {
    promoId: promo.id, venueId: promo.venueId, bonusZar: promo.bonusZar,
    requiredTurnoverZar: turnover, lossRate, cycles, cycleStakeZar: stake,
    totalHedgingCostZar: hedgingCost, expectedValueZar: ev, evPerDay,
    breakEvenLossRate: breakEven,
    viable: ev > 0 && backOdds >= promo.minOdds,
    warnings,
  };
}

/** Promos researched in the spec. Terms MUST be re-verified against the operator's
 *  own account before being relied on — they change often and vary by jurisdiction. */
export const RESEARCHED_PROMOS: Promo[] = [
  {
    id: "wsb_signup_2026", venueId: "wsb", name: "WSB 100% deposit match",
    bonusZar: 20000, rolloverMultiple: 5, minOdds: 1.5, kind: "cash",
    depositRequiredZar: 20000,
    onePerHousehold: true,
    termsNote: "100% up to R20,000, 5x rollover, min odds 1.50, one per person/household/IP",
  },
  {
    id: "betfred_signup_2026", venueId: "betfred_sa", name: "Betfred SA signup bonus",
    bonusZar: 5000, rolloverMultiple: 5, minOdds: 1.0, kind: "cash",
    onePerHousehold: true, termsNote: "up to R5,000 at 5x rollover",
  },
  {
    id: "betway_signup_2026", venueId: "betway_sa", name: "Betway signup bonus",
    bonusZar: 1000, rolloverMultiple: 3, minOdds: 1.0, kind: "cash",
    onePerHousehold: true, termsNote: "up to R1,000 at 3x rollover",
  },
];

export function rankPromos(promos: Promo[], backOdds: number, hedgeOdds: number): PromoEV[] {
  return promos
    .filter((p) => p.bonusZar > 0)
    .map((p) => evaluatePromo(p, backOdds, hedgeOdds))
    .sort((a, b) => b.expectedValueZar - a.expectedValueZar);
}
