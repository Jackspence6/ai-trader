// What you actually have to put up — TypeScript port of
// backend/oddsengine/bankroll.py, kept in lockstep by scripts/check-arb-parity.mjs.
//
// promos.ts answers "what is this bonus worth?". This answers "what do I have to
// put in?", and they are very different numbers:
//
//   * Turnover is not capital. A 5x rollover on a R2,000 bonus is R10,000 of bets
//     but not R10,000 of money — each hedged cycle returns ~98% when it settles and
//     funds the next one. Capital is what you need at once.
//   * A deposit match scales down and comes back. "100% up to R20,000" pays R2,000
//     of bonus on a R2,000 deposit, and the deposit is withdrawn at the end. EV is
//     near-linear in what you put up, right down to small amounts.
//   * Each book's balance swings even though the pair is flat. Back at 2.0 and about
//     half those bets lose, draining the promo book while the hedge book fills. The
//     float at each book has to survive a losing run, sized from the real
//     probability rather than a rule of thumb.

import type { Promo } from "./promos";
import { freeBetValue, pairOverround, qualifyingLossRate } from "./promos";

/** Smallest bet most SA books accept. Below this a plan is not executable. */
export const MIN_BET_ZAR = 10;

/** Chance we accept of a losing run exhausting a book's float mid-clearance. */
export const DEFAULT_RUIN_TOLERANCE = 0.05;

/** Every cycle is two hand-placed bets. Past this the plan is real on paper and a
 *  chore in practice, so capital goes into bigger stakes rather than more of them. */
export const DEFAULT_MAX_CYCLES = 60;

/** P(at least one run of `runLength` consecutive losses in `nCycles`). Exact DP. */
export function runProbability(nCycles: number, runLength: number, pLoss: number): number {
  if (runLength <= 0) return 1;
  if (nCycles < runLength) return 0;
  if (!(pLoss > 0 && pLoss < 1)) throw new Error("pLoss must be strictly between 0 and 1");

  let state: number[] = new Array(runLength).fill(0);
  state[0] = 1;
  let hit = 0;
  for (let i = 0; i < nCycles; i++) {
    const next: number[] = new Array(runLength).fill(0);
    for (let r = 0; r < runLength; r++) {
      const prob = state[r];
      if (prob === 0) continue;
      if (r + 1 >= runLength) hit += prob * pLoss;
      else next[r + 1] += prob * pLoss;
      next[0] += prob * (1 - pLoss);
    }
    state = next;
  }
  return hit;
}

/** Shortest float, in cycles, that survives the clearance with probability
 *  >= 1 - tolerance. Always at least 1. */
export function survivableRun(
  nCycles: number, pLoss: number, tolerance = DEFAULT_RUIN_TOLERANCE,
): number {
  for (let run = 1; run <= nCycles + 1; run++) {
    if (runProbability(nCycles, run, pLoss) <= tolerance) return run;
  }
  return nCycles;
}

export interface BookFloat {
  venue: string;
  stakePerCycleZar: number;
  bufferCycles: number;
  floatZar: number;
  fundedByBonusZar: number;
}

export interface CapitalPlan {
  promoId: string;
  bonusZar: number;
  depositZar: number;
  turnoverZar: number;
  cycleStakeZar: number;
  cycles: number;
  lossRate: number;
  hedgingCostZar: number;
  expectedValueZar: number;
  promoBook: BookFloat;
  hedgeBook: BookFloat;
  totalCapitalZar: number;
  capitalAtRiskZar: number;
  cashOutZar: number;
  returnOnCapitalPct: number;
  bufferCycles: number;
  executable: boolean;
  warnings: string[];
}

function winProbability(backOdds: number, hedgeOdds: number): number {
  const qBack = 1 / backOdds;
  const total = qBack + 1 / hedgeOdds;
  return total ? qBack / total : 0.5;
}

export function planCapital(
  promo: Promo, backOdds: number, hedgeOdds: number,
  opts: { depositZar: number; cycleStakeZar?: number; tolerance?: number },
): CapitalPlan {
  const { depositZar, cycleStakeZar, tolerance = DEFAULT_RUIN_TOLERANCE } = opts;
  const warnings: string[] = [];
  if (depositZar <= 0) throw new Error("deposit must be positive");

  let bonusZar: number;
  if (promo.depositRequiredZar && promo.depositRequiredZar > 0) {
    const matchRatio = promo.bonusZar / promo.depositRequiredZar;
    bonusZar = Math.min(depositZar * matchRatio, promo.bonusZar);
  } else {
    bonusZar = promo.bonusZar;
    warnings.push(
      "promo has no recorded deposit requirement — treated as a fixed bonus, so EV does " +
      "NOT scale with the deposit. Verify the terms before relying on this.");
  }

  const lossRate = qualifyingLossRate(backOdds, hedgeOdds);
  const overround = pairOverround(backOdds, hedgeOdds);
  const turnoverZar = bonusZar * promo.rolloverMultiple;

  if (backOdds < promo.minOdds) {
    warnings.push(
      `back odds ${backOdds.toFixed(2)} are below the promo minimum ` +
      `${promo.minOdds.toFixed(2)} — this turnover would not count`);
  }

  const bookBalance = depositZar + bonusZar;
  let stake = cycleStakeZar ?? Math.max(bookBalance / 8, MIN_BET_ZAR);
  stake = Math.max(stake, MIN_BET_ZAR);
  const cycles = Math.max(1, Math.ceil(turnoverZar / stake));

  const pLoss = 1 - winProbability(backOdds, hedgeOdds);
  const bufferCycles = survivableRun(cycles, pLoss, tolerance);

  const hedgeStake = (stake * backOdds) / hedgeOdds;
  const promoFloat = stake * bufferCycles;
  const hedgeFloat = hedgeStake * bufferCycles;

  if (promoFloat > bookBalance) {
    warnings.push(
      `a run of ${bufferCycles} losses would need R${Math.round(promoFloat).toLocaleString()} ` +
      `at ${promo.venueId} but the balance is only R${Math.round(bookBalance).toLocaleString()} ` +
      `— lower the cycle stake or raise the deposit`);
  }

  const hedgingCostZar = turnoverZar * lossRate;
  const realisable = promo.kind === "free_bet"
    ? freeBetValue(bonusZar, backOdds, hedgeOdds)
    : bonusZar;
  const expectedValueZar = realisable - hedgingCostZar;
  const totalCapitalZar = depositZar + hedgeFloat;

  if (overround > 1.15) {
    warnings.push(
      `back ${backOdds.toFixed(2)} / hedge ${hedgeOdds.toFixed(2)} implies a ` +
      `${Math.round((overround - 1) * 100)}% overround — check the hedge is the OPPOSITE outcome`);
  }
  if (lossRate >= 1 / promo.rolloverMultiple) {
    warnings.push(
      `loss rate ${(lossRate * 100).toFixed(1)}% exceeds the ` +
      `${((1 / promo.rolloverMultiple) * 100).toFixed(1)}% break-even for a ` +
      `${promo.rolloverMultiple}x rollover`);
  }
  if (cycles > 200) {
    warnings.push(
      `${cycles} cycles at R${Math.round(stake).toLocaleString()} is a lot of manual ` +
      `placements — raise the cycle stake if the float allows`);
  }

  return {
    promoId: promo.id, bonusZar, depositZar, turnoverZar, cycleStakeZar: stake, cycles,
    lossRate, hedgingCostZar, expectedValueZar,
    promoBook: {
      venue: promo.venueId, stakePerCycleZar: stake, bufferCycles,
      floatZar: promoFloat, fundedByBonusZar: Math.min(bonusZar, promoFloat),
    },
    hedgeBook: {
      venue: "hedge", stakePerCycleZar: hedgeStake, bufferCycles,
      floatZar: hedgeFloat, fundedByBonusZar: 0,
    },
    totalCapitalZar,
    capitalAtRiskZar: hedgingCostZar,
    cashOutZar: totalCapitalZar + expectedValueZar,
    returnOnCapitalPct: totalCapitalZar ? (expectedValueZar / totalCapitalZar) * 100 : 0,
    bufferCycles,
    executable: expectedValueZar > 0 && backOdds >= promo.minOdds && stake >= MIN_BET_ZAR,
    warnings,
  };
}

/** The question people actually ask: I have R`capitalZar` — what happens? */
export function planFromCapital(
  promo: Promo, backOdds: number, hedgeOdds: number,
  opts: { capitalZar: number; tolerance?: number; maxCycles?: number },
): CapitalPlan {
  const { capitalZar, tolerance = DEFAULT_RUIN_TOLERANCE, maxCycles = DEFAULT_MAX_CYCLES } = opts;
  if (capitalZar <= 0) throw new Error("capital must be positive");

  let best: CapitalPlan | null = null;
  let fallback: CapitalPlan | null = null;

  for (let pct = 50; pct <= 95; pct += 5) {
    const depositZar = (capitalZar * pct) / 100;
    if (depositZar < MIN_BET_ZAR) continue;
    const hedgeBudget = capitalZar - depositZar;
    let stake = Math.max(hedgeBudget / 8, MIN_BET_ZAR);
    let plan = planCapital(promo, backOdds, hedgeOdds,
      { depositZar, cycleStakeZar: stake, tolerance });
    for (let i = 0; i < 8; i++) {
      const need = plan.hedgeBook.floatZar;
      if (need <= hedgeBudget * 1.001) break;
      stake = Math.max((stake * hedgeBudget) / need, MIN_BET_ZAR);
      plan = planCapital(promo, backOdds, hedgeOdds,
        { depositZar, cycleStakeZar: stake, tolerance });
    }
    fallback = fallback ?? plan;
    if (plan.cycles > maxCycles) continue;
    if (plan.executable && plan.hedgeBook.floatZar <= hedgeBudget * 1.001) {
      if (!best || plan.expectedValueZar > best.expectedValueZar) best = plan;
    }
  }

  const chosen = best ?? (fallback as CapitalPlan);
  if (!best) {
    chosen.warnings = [
      ...chosen.warnings,
      `R${Math.round(capitalZar).toLocaleString()} cannot clear this promo within ` +
      `${maxCycles} cycles while keeping a float that survives a losing run — the plan ` +
      `below is the closest fit, not a safe one`,
    ];
  }
  return chosen;
}

/** Calendar time, given how many hedged pairs a day you can actually place. */
export function daysToClear(plan: CapitalPlan, cyclesPerDay: number): number {
  if (cyclesPerDay <= 0) throw new Error("cyclesPerDay must be positive");
  return plan.cycles / cyclesPerDay;
}
