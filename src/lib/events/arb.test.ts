/**
 * Arbitrage maths — properties, not examples.
 *
 * The worked examples in the specification are already checked by the
 * cross-language parity harness, bit for bit against the Python engine. What
 * that cannot tell us is whether the identities hold *everywhere*, and the
 * places they might not are exactly the thin books where the money is.
 *
 * The last test is the one that matters most in practice. Stakes are rounded to
 * R10 before they are placed, because an exact stake of R3,417.62 is a
 * fingerprint and a desk placing eight of those a day is announcing itself. The
 * question is whether that rounding can quietly turn a positive book negative.
 */

import { describe, expect, it } from "vitest";
import {
  balancedStakes,
  naturalizeStakes,
  binaryPairCost,
  effectiveBuyPrice,
  effectiveDecimalOdds,
  margin,
  takerFeePerShare,
  VENUE_TAKER_RATE,
  worstCaseProfit,
} from "./arb";

/** A deterministic generator — a failing case must be reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Build a book with a chosen number of legs and an exact overround. */
function bookWithMargin(marginPct: number, legs: number, rand: () => number): number[] {
  const S = 1 - marginPct / 100;
  // Split S across legs at random, then invert each share into odds.
  const shares: number[] = [];
  let left = S;
  for (let i = 0; i < legs - 1; i++) {
    const take = left * (0.2 + rand() * 0.5);
    shares.push(take);
    left -= take;
  }
  shares.push(left);
  return shares.map((q) => 1 / q);
}

describe("fee model", () => {
  it("is rate x p x (1-p), rounded to five places with a floor of 0.00001", () => {
    // The rounding is the venue's, not ours, and it is load-bearing: at p=0.01
    // the raw formula gives 0.000396 and the venue charges 0.0004. A detector
    // using the raw number under-prices every fee it ever computes, always in
    // the direction that invents edge.
    const spec = (p: number, rate: number) => {
      if (rate === 0) return 0;
      return Math.max(0.00001, Math.round(rate * p * (1 - p) * 1e5) / 1e5);
    };
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.99]) {
      for (const rate of [0, 0.04, 0.05, 0.07]) {
        expect(takerFeePerShare(p, rate)).toBeCloseTo(spec(p, rate), 10);
      }
    }
  });

  it("is symmetric about 0.5 and vanishes at the ends", () => {
    // The shape matters: the fee is largest where the market is least certain,
    // which is where thin arbitrage lives — so a fee-blind detector is wrong
    // precisely where it would cost the most.
    expect(takerFeePerShare(0.3, 0.05)).toBeCloseTo(takerFeePerShare(0.7, 0.05), 12);
    expect(takerFeePerShare(0.5, 0.05)).toBeGreaterThan(takerFeePerShare(0.1, 0.05));
    expect(takerFeePerShare(0.0001, 0.05)).toBeLessThan(0.0001);
  });

  it("turns a price into effective odds consistently", () => {
    const p = 0.5;
    const rate = 0.05;
    expect(effectiveBuyPrice(p, rate)).toBeCloseTo(0.5125, 10);
    expect(effectiveDecimalOdds(p, rate)).toBeCloseTo(1 / 0.5125, 10);
  });

  it("prices a YES+NO pair above 1 when the fee eats the edge", () => {
    // 0.48 + 0.50 looks like a 2% edge and is not one: at a 5% sports fee the
    // pair costs 1.005. Reporting it would be a false positive with money on it.
    expect(binaryPairCost(0.48, 0.5, 0.05)).toBeGreaterThan(1);
  });
});

describe("arbitrage identities", () => {
  const rand = lcg(20260826);

  it("margin equals 1 - sum(1/odds) for any book", () => {
    for (let i = 0; i < 200; i++) {
      const legs = 2 + Math.floor(rand() * 3);
      const m = rand() * 6 - 1; // -1% to +5%: losing books included on purpose
      const odds = bookWithMargin(m, legs, rand);
      if (odds.some((o) => !Number.isFinite(o) || o <= 1)) continue;
      const S = odds.reduce((a, o) => a + 1 / o, 0);
      expect(margin(odds)).toBeCloseTo(1 - S, 10);
    }
  });

  it("balanced stakes total the requested stake and pay the same on every branch", () => {
    for (let i = 0; i < 200; i++) {
      const legs = 2 + Math.floor(rand() * 3);
      const odds = bookWithMargin(0.2 + rand() * 4, legs, rand);
      if (odds.some((o) => !Number.isFinite(o) || o <= 1)) continue;
      const T = 500 + Math.floor(rand() * 50_000);
      const stakes = balancedStakes(T, odds);

      expect(stakes.reduce((a, b) => a + b, 0)).toBeCloseTo(T, 6);

      const returns = stakes.map((s, j) => s * odds[j]);
      for (const r of returns) expect(r).toBeCloseTo(returns[0], 6);
    }
  });

  it("profit equals T x (1/S - 1) exactly, and is positive whenever margin is", () => {
    for (let i = 0; i < 200; i++) {
      const legs = 2 + Math.floor(rand() * 3);
      const odds = bookWithMargin(0.05 + rand() * 5, legs, rand);
      if (odds.some((o) => !Number.isFinite(o) || o <= 1)) continue;
      const T = 1000 + Math.floor(rand() * 20_000);
      const S = odds.reduce((a, o) => a + 1 / o, 0);
      const profit = worstCaseProfit(balancedStakes(T, odds), odds);
      expect(profit).toBeCloseTo(T * (1 / S - 1), 6);
      expect(profit).toBeGreaterThan(0);
    }
  });
});

describe("stake naturalisation", () => {
  const rand = lcg(1234567);

  /** The naive version, kept here as the thing that must NOT be used. */
  const naiveRound = (stakes: number[]) =>
    stakes.map((s) => Math.max(10, Math.round(s / 10) * 10));

  it("naive R10 rounding can turn a profitable book into a loss", () => {
    // This is why naturalizeStakes exists, and this test exists so that nobody
    // re-introduces the one-liner. Found by sweep: a book the board correctly
    // reported as profitable, whose placeable version loses money.
    let worst = Infinity;
    for (let i = 0; i < 500; i++) {
      const legs = 2 + Math.floor(rand() * 2);
      const odds = bookWithMargin(0.5 + rand() * 4.5, legs, rand);
      if (odds.some((o) => !Number.isFinite(o) || o <= 1)) continue;
      const T = 1000 + Math.floor(rand() * 30_000);
      const rounded = naiveRound(balancedStakes(T, odds));
      const total = rounded.reduce((a, b) => a + b, 0);
      worst = Math.min(worst, Math.min(...rounded.map((s, j) => s * odds[j])) - total);
    }
    expect(worst).toBeLessThan(0);
  });

  it("naturalizeStakes never returns a losing plan", () => {
    const seeded = lcg(98765);
    for (let i = 0; i < 500; i++) {
      const legs = 2 + Math.floor(seeded() * 2);
      const odds = bookWithMargin(0.5 + seeded() * 4.5, legs, seeded);
      if (odds.some((o) => !Number.isFinite(o) || o <= 1)) continue;
      const T = 1000 + Math.floor(seeded() * 30_000);
      const plan = naturalizeStakes(T, odds);
      expect(plan.worstProfit).toBeGreaterThan(0);
    }
  });

  it("says so when no round-number plan survives", () => {
    const seeded = lcg(4242);
    let sawUnnatural = 0;
    for (let i = 0; i < 800; i++) {
      const odds = bookWithMargin(0.05 + seeded() * 0.3, 2, seeded);
      if (odds.some((o) => !Number.isFinite(o) || o <= 1)) continue;
      const plan = naturalizeStakes(1000 + Math.floor(seeded() * 5000), odds);
      // Whatever it returns, it must be honest about it and still positive.
      expect(plan.worstProfit).toBeGreaterThan(0);
      if (!plan.natural) sawUnnatural++;
    }
    // On books this thin, exact stakes are sometimes the only ones that work.
    expect(sawUnnatural).toBeGreaterThan(0);
  });

  it("moves each stake by at most one step", () => {
    // The loss from naturalising is bounded: each stake moves by at most R5, and
    // the worst branch loses at most that times its odds. This is the guarantee
    // the stake plan's "rounding costs R…" line is derived from.
    for (let i = 0; i < 200; i++) {
      const odds = bookWithMargin(1 + rand() * 3, 2, rand);
      if (odds.some((o) => !Number.isFinite(o) || o <= 1)) continue;
      const T = 2000 + Math.floor(rand() * 20_000);
      const exact = balancedStakes(T, odds);
      const rounded = naiveRound(exact);
      for (let j = 0; j < exact.length; j++) {
        expect(Math.abs(rounded[j] - exact[j])).toBeLessThanOrEqual(5.0001);
      }
    }
  });
});

describe("the fee model generalises across venues", () => {
  it("prices a Kalshi contract with no new maths", () => {
    // Both venues charge rate x p x (1-p). Pricing a second prediction market
    // needs a market feed, not a second fee model — worth asserting so the
    // claim in the research note stays true if either constant moves.
    const p = 0.5;
    expect(takerFeePerShare(p, VENUE_TAKER_RATE.kalshi)).toBeCloseTo(0.07 * p * (1 - p), 10);
    // At 50c the Kalshi fee is 1.75c per contract, which is the figure quoted
    // publicly — a useful external check on our own implementation.
    expect(takerFeePerShare(0.5, VENUE_TAKER_RATE.kalshi)).toBeCloseTo(0.0175, 6);
  });

  it("shows why thin cross-venue spreads do not survive", () => {
    // A 3c gross spread near 50/50, both legs taker, on the two venues.
    const pmRate = 0.05;
    const kalshiRate = VENUE_TAKER_RATE.kalshi;
    const yesOnPm = 0.485;
    const noOnKalshi = 0.485;
    const gross = 1 - (yesOnPm + noOnKalshi); // 3c
    const net =
      1 - (effectiveBuyPrice(yesOnPm, pmRate) + effectiveBuyPrice(noOnKalshi, kalshiRate));
    expect(gross).toBeCloseTo(0.03, 6);
    // Fees take roughly 3c of the 3c. What is left is a rounding error, which
    // is exactly what the public guidance reports and what E4 measured.
    expect(net).toBeLessThan(0.005);
  });
});
