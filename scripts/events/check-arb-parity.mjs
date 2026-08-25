#!/usr/bin/env node
// Cross-language parity check: the TypeScript arb math used by the deployed
// Vercel app must agree with the Python engine to within 1e-9 on the spec §14.1
// worked examples. Run: node scripts/check-arb-parity.mjs   (CI runs it too.)

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const ts = await import(path.join(repo, "src/lib/events/arb.ts"));
const pr = await import(path.join(repo, "src/lib/events/promos.ts"));
const bk = await import(path.join(repo, "src/lib/events/bankroll.ts"));

const WSB = pr.RESEARCHED_PROMOS[0];
const PY_WSB = "next(p for p in promos.RESEARCHED_PROMOS if p.id=='wsb_signup_2026')";

// (label, ts value, python expression)
const CASES = [
  ["fee@0.50/0.05", ts.takerFeePerShare(0.5, 0.05), "fees.taker_fee_per_share(0.50, 0.05)"],
  ["fee@0.123/0.04", ts.takerFeePerShare(0.123, 0.04), "fees.taker_fee_per_share(0.123, 0.04)"],
  ["fee@tiny", ts.takerFeePerShare(0.0001, 0.04), "fees.taker_fee_per_share(0.0001, 0.04)"],
  ["fee@geopolitics", ts.takerFeePerShare(0.5, 0.0), "fees.taker_fee_per_share(0.5, 0.0)"],
  ["odds_eff@0.50/0.05", ts.effectiveDecimalOdds(0.5, 0.05), "fees.effective_decimal_odds(0.50, 0.05)"],
  ["yes+no cost", ts.binaryPairCost(0.48, 0.5, 0.05), "fees.binary_pair_cost(0.48, 0.50, 0.05)"],
  ["negrisk set", ts.negRiskFullSetCost([0.3, 0.32, 0.33], 0.04), "fees.negrisk_full_set_cost([0.30,0.32,0.33], 0.04)"],
  ["margin 2way", ts.margin([2.1, 2.05]), "arbmath.margin([2.10, 2.05])"],
  ["margin 3way", ts.margin([2.4, 3.8, 3.5]), "arbmath.margin([2.40, 3.80, 3.50])"],
  ["stake0 3way", ts.balancedStakes(10000, [2.4, 3.8, 3.5])[0], "arbmath.balanced_stakes(10000, [2.40,3.80,3.50])[0]"],
  ["stake2 3way", ts.balancedStakes(10000, [2.4, 3.8, 3.5])[2], "arbmath.balanced_stakes(10000, [2.40,3.80,3.50])[2]"],
  ["worst 2way", ts.worstCaseProfit(ts.balancedStakes(10000, [2.1, 2.05]), [2.1, 2.05]),
    "arbmath.worst_case_profit(arbmath.balanced_stakes(10000,[2.10,2.05]), [2.10,2.05])"],
  ["depth cap", ts.depthCapacityUsd([{ price: 0.5, size: 1000 }, { price: 0.52, size: 1000 }], 0.5, 0.05, 50),
    "arbmath.depth_capacity_usd([BookLevel(price=0.50,size=1000),BookLevel(price=0.52,size=1000)], 0.50, 0.05, 50)"],
  // --- promo & rollover hedging (spec §5 type 5, §14.8) ---
  ["promo loss rate", pr.qualifyingLossRate(1.55, 2.75), "promos.qualifying_loss_rate(1.55, 2.75)"],
  ["promo loss (even)", pr.qualifyingLossRate(2.0, 1.95), "promos.qualifying_loss_rate(2.00, 1.95)"],
  ["promo overround", pr.pairOverround(1.55, 2.75), "promos.pair_overround(1.55, 2.75)"],
  ["hedge stake", pr.planHedge(2.0, 1.95, 1000).hedgeStakeZar, "promos.plan_hedge(2.00, 1.95, 1000).hedge_stake_zar"],
  ["hedge loss", pr.planHedge(2.0, 1.95, 1000).lossZar, "promos.plan_hedge(2.00, 1.95, 1000).loss_zar"],
  ["pm hedge odds", pr.planHedgeOnPolymarket(2.0, 0.5, 0.05, 1000).hedgeOdds,
    "promos.plan_hedge_on_polymarket(2.00, 0.50, 0.05, 1000).hedge_odds"],
  ["free bet value", pr.freeBetValue(100, 6.0, 1.2), "promos.free_bet_value(100, 6.0, 1.20)"],
  ["WSB promo EV", pr.evaluatePromo(pr.RESEARCHED_PROMOS[0], 1.55, 2.75).expectedValueZar,
    "promos.evaluate_promo(next(p for p in promos.RESEARCHED_PROMOS if p.id=='wsb_signup_2026'), 1.55, 2.75).expected_value_zar"],
  ["WSB break-even", pr.evaluatePromo(pr.RESEARCHED_PROMOS[0], 1.55, 2.75).breakEvenLossRate,
    "promos.evaluate_promo(next(p for p in promos.RESEARCHED_PROMOS if p.id=='wsb_signup_2026'), 1.55, 2.75).break_even_loss_rate"],
  // --- capital planning (bankroll.py / bankroll.ts) ---
  // The losing-run DP is the number that sizes each book's float, so it has to
  // agree exactly, not approximately.
  ["run P(5 in 40)", bk.runProbability(40, 5, 0.5), "bankroll.run_probability(40, 5, 0.5)"],
  ["run P(3 in 10)", bk.runProbability(10, 3, 0.47), "bankroll.run_probability(10, 3, 0.47)"],
  ["survivable run", bk.survivableRun(55, 0.497), "bankroll.survivable_run(55, 0.497)"],
  ["match bonus scales", bk.planCapital(WSB, 1.96, 1.99, { depositZar: 2000, cycleStakeZar: 200 }).bonusZar,
    `bankroll.plan_capital(${PY_WSB}, 1.96, 1.99, deposit_zar=2000, cycle_stake_zar=200).bonus_zar`],
  ["capital total", bk.planCapital(WSB, 1.96, 1.99, { depositZar: 2000, cycleStakeZar: 200 }).totalCapitalZar,
    `bankroll.plan_capital(${PY_WSB}, 1.96, 1.99, deposit_zar=2000, cycle_stake_zar=200).total_capital_zar`],
  ["capital EV", bk.planCapital(WSB, 1.96, 1.99, { depositZar: 2000, cycleStakeZar: 200 }).expectedValueZar,
    `bankroll.plan_capital(${PY_WSB}, 1.96, 1.99, deposit_zar=2000, cycle_stake_zar=200).expected_value_zar`],
  ["hedge float", bk.planCapital(WSB, 1.96, 1.99, { depositZar: 2000, cycleStakeZar: 200 }).hedgeBook.floatZar,
    `bankroll.plan_capital(${PY_WSB}, 1.96, 1.99, deposit_zar=2000, cycle_stake_zar=200).hedge_book.float_zar`],
  ["R2k plan EV", bk.planFromCapital(WSB, 1.96, 1.99, { capitalZar: 2000 }).expectedValueZar,
    `bankroll.plan_from_capital(${PY_WSB}, 1.96, 1.99, capital_zar=2000).expected_value_zar`],
  ["R2k plan deposit", bk.planFromCapital(WSB, 1.96, 1.99, { capitalZar: 2000 }).depositZar,
    `bankroll.plan_from_capital(${PY_WSB}, 1.96, 1.99, capital_zar=2000).deposit_zar`],
  ["R2k plan cycles", bk.planFromCapital(WSB, 1.96, 1.99, { capitalZar: 2000 }).cycles,
    `bankroll.plan_from_capital(${PY_WSB}, 1.96, 1.99, capital_zar=2000).cycles`],
];

const pySrc = `
import json, sys
sys.path.insert(0, "services/events-engine/backend")
from oddsengine import fees, arbmath, promos, bankroll
from oddsengine.models import BookLevel
print(json.dumps([${CASES.map((c) => c[2]).join(", ")}]))
`;

const out = execFileSync("python3", ["-c", pySrc], { cwd: repo, encoding: "utf8" });
const pyVals = JSON.parse(out.trim());

let failed = 0;
for (let i = 0; i < CASES.length; i++) {
  const [label, tsVal] = CASES[i];
  const pyVal = pyVals[i];
  const delta = Math.abs(tsVal - pyVal);
  const ok = delta < 1e-9;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(20)} ts=${tsVal}  py=${pyVal}  Δ=${delta.toExponential(2)}`,
  );
}

// Spec §14.1 absolute anchors (guards against both sides drifting together).
const anchors = [
  ["§14.1 2-way margin 3.60%", ts.margin([2.1, 2.05]) * 100, 3.6, 0.01],
  ["§14.1 3-way margin 3.44%", ts.margin([2.4, 3.8, 3.5]) * 100, 3.44, 0.01],
  ["§14.1 PM p_eff 0.5125", ts.effectiveBuyPrice(0.5, 0.05), 0.5125, 1e-9],
  ["§14.1 PM o_eff 1.951", ts.effectiveDecimalOdds(0.5, 0.05), 1.951, 1e-3],
  ["§14.1 YES+NO 1.005 (no arb)", ts.binaryPairCost(0.48, 0.5, 0.05), 1.005, 1e-3],
  // Capital is not turnover: R2,000 up front clears R5,500 of qualifying bets.
  ["R2k clears >2x its own size", bk.planFromCapital(WSB, 1.96, 1.99, { capitalZar: 2000 }).turnoverZar / 2000, 2.75, 0.3],
  // A deposit match returns roughly what you put in, less the hedging cost.
  ["R2k returns ~48% on capital", bk.planFromCapital(WSB, 1.96, 1.99, { capitalZar: 2000 }).returnOnCapitalPct, 48, 3],
];
for (const [label, got, want, tol] of anchors) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(30)} got=${got} want=${want}`);
}

if (failed) {
  console.error(`\n${failed} parity check(s) FAILED — TS and Python arb math have diverged.`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length + anchors.length} parity checks passed.`);
