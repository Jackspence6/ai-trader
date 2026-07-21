/**
 * Tests for the calculation core.
 *
 * These are not coverage theatre. Every assertion below is either a
 * hand-computable value or a property that, if it broke silently, would cause
 * the system to size a position wrongly or trade an edge that isn't there.
 */

import { describe, expect, it } from "vitest";
import {
  atr,
  correlation,
  donchian,
  ema,
  latest,
  logReturns,
  maxDrawdown,
  mean,
  percentileRank,
  realisedVol,
  rsi,
  sharpe,
  sma,
  stdev,
  zscore,
} from "./indicators";
import {
  bindingMinNotional,
  DEFAULT_VENUE_FEES,
  executionCost,
  minNotionalFor,
  halfSpreadBps,
  legFeeBps,
  minNotionalDragBps,
  roundTripCost,
  slippageBps,
  type LegSpec,
} from "./costs";
import {
  annualiseFunding,
  classifyFundingRegime,
  deannualiseFunding,
  evaluateCarry,
  evaluateFundingSpread,
} from "./funding";
import {
  atrStopDistance,
  fractionalKelly,
  quantiseNotional,
  riskUnitSize,
  taperToLimit,
  volatilityTargetSize,
} from "./sizing";
import { PROMOTION_HOLD_DAYS, resolveTier, TIERS, tierForNav, unlockTierFor } from "./tiers";
import { evaluateGate, type GateInput } from "./gate";

/* ------------------------------------------------------------- indicators */

describe("indicators", () => {
  it("mean and stdev use the sample (n-1) denominator", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    // Sample stdev of [2,4,4,4,5,5,7,9] is 2.138..., population is 2.0.
    // The distinction matters: population form biases volatility low, which
    // would oversize every position.
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])!).toBeCloseTo(2.13809, 4);
    expect(stdev([5])).toBeNull();
  });

  it("sma warms up with nulls and preserves index alignment", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
    expect(out.length).toBe(5);
  });

  it("ema seeds from the SMA of the first n points", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(2); // SMA(1,2,3)
    // k = 2/(3+1) = 0.5 → 4*0.5 + 2*0.5 = 3
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it("zscore returns null for a flat window rather than dividing by zero", () => {
    const out = zscore([5, 5, 5, 5], 3);
    expect(out[2]).toBeNull();
    expect(out[3]).toBeNull();
  });

  it("zscore measures deviation in standard deviations", () => {
    const out = zscore([1, 2, 3, 4, 10], 5);
    const w = [1, 2, 3, 4, 10];
    const expected = (10 - mean(w)!) / stdev(w)!;
    expect(out[4]!).toBeCloseTo(expected, 10);
  });

  it("rsi pins to 100 when there are no down moves", () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(latest(rsi(rising, 14))!).toBe(100);
  });

  it("rsi sits near 50 for a symmetric oscillation", () => {
    const osc = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const v = latest(rsi(osc, 14))!;
    expect(v).toBeGreaterThan(40);
    expect(v).toBeLessThan(60);
  });

  it("atr accounts for gaps, not just the bar range", () => {
    // Every bar has range 1, but each gaps 10 above the previous close, so
    // true range is dominated by the gap. A high-low-only implementation
    // would report ~1 here and badly undersize stops.
    const n = 20;
    const highs = Array.from({ length: n }, (_, i) => 100 + i * 10 + 1);
    const lows = Array.from({ length: n }, (_, i) => 100 + i * 10);
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 10 + 0.5);
    const v = latest(atr(highs, lows, closes, 14))!;
    expect(v).toBeGreaterThan(9);
  });

  it("donchian excludes the current bar so breakouts can actually trigger", () => {
    const highs = [1, 2, 3, 4, 99];
    const lows = [1, 2, 3, 4, 99];
    const { upper } = donchian(highs, lows, 4);
    // At index 4 the channel looks back over indices 0..3 only.
    expect(upper[4]).toBe(4);
    expect(highs[4]).toBeGreaterThan(upper[4]!);
  });

  it("maxDrawdown reports the worst peak-to-trough decline", () => {
    expect(maxDrawdown([100, 120, 60, 80])).toBeCloseTo(-0.5, 10);
    expect(maxDrawdown([100, 101, 102])).toBe(0);
  });

  it("realisedVol annualises with 365 periods for crypto", () => {
    const closes = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101];
    const daily = realisedVol(closes, 365, 30)!;
    const weekly = realisedVol(closes, 52, 30)!;
    expect(daily).toBeGreaterThan(weekly);
    // Using 252 (equities) instead of 365 understates crypto vol materially.
    const equityConvention = realisedVol(closes, 252, 30)!;
    expect(daily / equityConvention).toBeCloseTo(Math.sqrt(365 / 252), 6);
  });

  it("sharpe is null on a constant series (zero dispersion)", () => {
    expect(sharpe([0.01, 0.01, 0.01])).toBeNull();
  });

  it("correlation detects perfect positive and negative relationships", () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])!).toBeCloseTo(1, 10);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])!).toBeCloseTo(-1, 10);
  });

  it("percentileRank places a value within its own history", () => {
    expect(percentileRank([1, 2, 3, 4], 3.5)).toBe(0.75);
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0);
  });

  it("logReturns are additive across time", () => {
    const lr = logReturns([100, 110, 121]).filter((x): x is number => x !== null);
    expect(lr[0] + lr[1]).toBeCloseTo(Math.log(121 / 100), 10);
  });
});

/* ------------------------------------------------------------------ costs */

describe("cost model", () => {
  it("computes half-spread relative to mid", () => {
    // bid 99.5 / ask 100.5 → 1% spread → half-spread 50bp
    expect(halfSpreadBps(99.5, 100.5)).toBeCloseTo(50, 6);
    expect(halfSpreadBps(0, 100)).toBe(0);
  });

  it("charges maker and taker differently", () => {
    const b = DEFAULT_VENUE_FEES.binance;
    expect(legFeeBps(b, "perp", "maker")).toBeLessThan(legFeeBps(b, "perp", "taker"));
  });

  it("slippage scales with the square root of participation, not linearly", () => {
    const a = slippageBps(1_000, 100_000, 10);
    const b = slippageBps(4_000, 100_000, 10);
    // 4x the size should be 2x the impact under a square-root model.
    expect(b / a).toBeCloseTo(2, 6);
  });

  it("charges punitively when depth is unknown rather than assuming zero cost", () => {
    expect(slippageBps(1_000, 0, 10)).toBe(50);
  });

  it("makers pay no half-spread; takers pay spread plus impact", () => {
    const base: LegSpec = {
      venue: "binance",
      market: "spot",
      liquidity: "taker",
      notionalUsd: 1_000,
      spreadBps: 10,
      depthUsd: 500_000,
    };
    const taker = executionCost([base]);
    const maker = executionCost([{ ...base, liquidity: "maker" }]);
    expect(maker.spreadBps).toBe(0);
    expect(maker.slippageBps).toBe(0);
    expect(taker.spreadBps).toBeGreaterThan(0);
    expect(taker.totalBps).toBeGreaterThan(maker.totalBps);
  });

  it("an unknown venue falls back to the worst known fees, never to free", () => {
    const leg: LegSpec = {
      venue: "some-exchange-we-have-never-heard-of",
      market: "spot",
      liquidity: "taker",
      notionalUsd: 1_000,
      spreadBps: 5,
      depthUsd: 100_000,
    };
    expect(executionCost([leg]).feeBps).toBeGreaterThan(0);
  });

  it("round trip is exactly twice the one-way cost", () => {
    const legs: LegSpec[] = [
      {
        venue: "binance",
        market: "spot",
        liquidity: "taker",
        notionalUsd: 1_000,
        spreadBps: 4,
        depthUsd: 250_000,
      },
    ];
    expect(roundTripCost(legs).totalUsd).toBeCloseTo(executionCost(legs).totalUsd * 2, 10);
  });

  it("knows perp minimums differ from spot, and by a lot", () => {
    // Verified against Binance's own exchangeInfo on mainnet AND testnet:
    // BTC perp is $50, BTC spot is $5. Assuming one flat venue minimum
    // understates drag and makes unviable trades look viable.
    const b = DEFAULT_VENUE_FEES.binance;
    expect(minNotionalFor(b, "spot")).toBe(5);
    expect(minNotionalFor(b, "perp")).toBe(50);
  });

  it("takes the LARGEST minimum across a multi-leg trade", () => {
    // A carry only works if both legs fill. Sizing to the smaller minimum
    // leaves one leg rejected, and a half-filled carry is a naked position.
    const carry = bindingMinNotional([
      { venue: "binance", market: "spot" },
      { venue: "binance", market: "perp" },
    ]);
    expect(carry).toBe(50);
  });

  it("takes the largest across venues too, for a cross-venue spread", () => {
    const spread = bindingMinNotional([
      { venue: "bybit", market: "perp" },
      { venue: "hyperliquid", market: "perp" },
    ]);
    expect(spread).toBe(10);
  });

  it("falls back to the worst known venue for an unknown one", () => {
    const unknown = bindingMinNotional([{ venue: "never-heard-of-it", market: "perp" }]);
    expect(unknown).toBeGreaterThan(0);
  });

  it("min-notional drag is zero once intended size clears the minimum", () => {
    expect(minNotionalDragBps(100, 5, 20)).toBe(0);
  });

  it("min-notional drag scales with how far under the minimum we are", () => {
    // Wanted $5 of exposure, forced to trade $10: the same cost over half the
    // intended exposure, so an extra 100% of the round-trip cost.
    expect(minNotionalDragBps(5, 10, 20)).toBeCloseTo(20, 10);
  });
});

/* ---------------------------------------------------------------- funding */

describe("funding carry", () => {
  it("annualises an 8h funding rate over 1095 intervals per year", () => {
    // 0.01% per 8h → 0.01% × (8760/8) = 10.95% APR
    expect(annualiseFunding(0.0001, 8)).toBeCloseTo(0.1095, 10);
  });

  it("annualisation round-trips", () => {
    expect(deannualiseFunding(annualiseFunding(0.0001, 8), 8)).toBeCloseTo(0.0001, 12);
  });

  it("treats hourly and 8-hourly venues comparably", () => {
    // Hyperliquid pays 1/8 the rate 8x as often — the same APR.
    expect(annualiseFunding(0.0001 / 8, 1)).toBeCloseTo(annualiseFunding(0.0001, 8), 12);
  });

  const cost = { feeBps: 0, spreadBps: 0, slippageBps: 0, totalBps: 20, totalUsd: 2 };

  it("capital efficiency is L/(L+1)", () => {
    const r3 = evaluateCarry({
      fundingRate: 0.0001,
      intervalHours: 8,
      legNotionalUsd: 1_000,
      perpLeverage: 3,
      cost,
      expectedHoldDays: 30,
    });
    expect(r3.capitalEfficiency).toBeCloseTo(0.75, 10);
    expect(r3.capitalRequiredUsd).toBeCloseTo(1_333.333, 3);

    const r5 = evaluateCarry({
      fundingRate: 0.0001,
      intervalHours: 8,
      legNotionalUsd: 1_000,
      perpLeverage: 5,
      cost,
      expectedHoldDays: 30,
    });
    expect(r5.capitalEfficiency).toBeCloseTo(0.8333, 4);
    // Going 3x → 5x buys ~11% more yield but moves liquidation much closer.
    expect(r5.liquidationDistance).toBeLessThan(r3.liquidationDistance);
  });

  it("computes breakeven days from cost and daily funding", () => {
    // 10.95% APR = 0.03% per day. A 0.2% round trip takes ~6.7 days to repay.
    const r = evaluateCarry({
      fundingRate: 0.0001,
      intervalHours: 8,
      legNotionalUsd: 1_000,
      perpLeverage: 3,
      cost,
      expectedHoldDays: 30,
    });
    expect(r.breakevenDays).toBeCloseTo(0.002 / (0.1095 / 365), 4);
    expect(r.breakevenDays).toBeGreaterThan(6);
    expect(r.breakevenDays).toBeLessThan(7);
  });

  it("the same opportunity is bad held briefly and good held long", () => {
    const base = {
      fundingRate: 0.0001,
      intervalHours: 8,
      legNotionalUsd: 1_000,
      perpLeverage: 3,
      cost,
    };
    const short = evaluateCarry({ ...base, expectedHoldDays: 1 });
    const long = evaluateCarry({ ...base, expectedHoldDays: 60 });
    expect(short.expectedProfitUsd).toBeLessThan(0);
    expect(long.expectedProfitUsd).toBeGreaterThan(0);
    expect(long.netApr).toBeGreaterThan(short.netApr);
  });

  it("negative funding produces a negative gross APR and infinite breakeven", () => {
    const r = evaluateCarry({
      fundingRate: -0.0001,
      intervalHours: 8,
      legNotionalUsd: 1_000,
      perpLeverage: 3,
      cost,
      expectedHoldDays: 30,
    });
    expect(r.grossApr).toBeLessThan(0);
    expect(r.breakevenDays).toBe(Infinity);
  });

  it("liquidation distance shrinks as leverage rises", () => {
    const mk = (lev: number) =>
      evaluateCarry({
        fundingRate: 0.0001,
        intervalHours: 8,
        legNotionalUsd: 1_000,
        perpLeverage: lev,
        cost,
        expectedHoldDays: 30,
        maintenanceMargin: 0.005,
      }).liquidationDistance;
    expect(mk(2)).toBeCloseTo(0.495, 10);
    expect(mk(10)).toBeCloseTo(0.095, 10);
    expect(mk(200)).toBe(0);
  });

  it("cross-venue spread needs margin on both venues", () => {
    const r = evaluateFundingSpread({
      shortVenue: "bybit",
      longVenue: "hyperliquid",
      shortAnnualRate: 0.2,
      longAnnualRate: -0.05,
      legNotionalUsd: 1_000,
      perpLeverage: 4,
      cost,
      expectedHoldDays: 30,
    });
    expect(r.spreadApr).toBeCloseTo(0.25, 10);
    // Two perp legs at 4x → 2 × 1000/4 = 500.
    expect(r.capitalRequiredUsd).toBeCloseTo(500, 10);
    expect(r.expectedProfitUsd).toBeGreaterThan(0);
  });

  it("classifies funding regimes on the median, not the latest spike", () => {
    // A single 300% APR print on an otherwise thin series must not read "rich"
    // — that print is usually a liquidation artefact that reverts immediately.
    const spiky = [0.01, 0.01, 0.012, 0.008, 3.0];
    const r = classifyFundingRegime(spiky)!;
    expect(r.label).toBe("thin");
    expect(r.latestApr).toBe(3.0);
    expect(r.medianApr).toBeCloseTo(0.01, 10);
    expect(r.percentile).toBe(0.8);
  });

  it("flags an inverted regime when the median is negative", () => {
    expect(classifyFundingRegime([-0.05, -0.02, -0.08])!.label).toBe("inverted");
  });

  it("returns null for an empty funding history rather than a fake reading", () => {
    expect(classifyFundingRegime([])).toBeNull();
  });
});

/* ----------------------------------------------------------------- sizing */

describe("sizing", () => {
  it("vol targeting equalises risk across assets of different volatility", () => {
    const nav = 10_000;
    const btc = volatilityTargetSize(nav, 0.1, 0.4, 1);
    const sol = volatilityTargetSize(nav, 0.1, 0.8, 1);
    // SOL is twice as volatile, so it gets half the notional.
    expect(btc / sol).toBeCloseTo(2, 10);
  });

  it("caps position size even when an asset looks unusually quiet", () => {
    // Low measured vol often precedes high vol; an uncapped sizer would build
    // an enormous position right before that resolves.
    expect(volatilityTargetSize(10_000, 0.1, 0.001, 0.25)).toBe(2_500);
  });

  it("risk-unit sizing loses the same money on every stop-out", () => {
    const nav = 10_000;
    const size = riskUnitSize(nav, 0.01, 0.05, 1);
    expect(size).toBe(2_000);
    expect(size * 0.05).toBeCloseTo(nav * 0.01, 10);
  });

  it("atr stop distance is a multiple of ATR relative to price", () => {
    expect(atrStopDistance(100, 1_000, 2.5)).toBeCloseTo(0.25, 10);
  });

  it("never returns full Kelly", () => {
    // p=0.6, 1:1 payoff → full Kelly 0.2; quarter Kelly 0.05.
    expect(fractionalKelly(0.6, 1, 0.25)).toBeCloseTo(0.05, 10);
    expect(fractionalKelly(0.6, 1, 0.25)).toBeLessThan(0.6 - 0.4);
  });

  it("clamps a negative edge to zero rather than inverting the bet", () => {
    expect(fractionalKelly(0.3, 1)).toBe(0);
  });

  it("tapers size as a limit is approached instead of cutting off at a cliff", () => {
    const full = taperToLimit(100, 0, 1_000, 0.7);
    const near = taperToLimit(100, 850, 1_000, 0.7);
    const at = taperToLimit(100, 1_000, 1_000, 0.7);
    expect(full).toBe(100);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(100);
    expect(at).toBe(0);
  });

  it("quantises down to the lot step and rejects sub-minimum results", () => {
    // $100 at price 10 with step 1 → 10 units exactly.
    expect(quantiseNotional(100, 10, 1, 5)).toEqual({ qty: 10, notionalUsd: 100 });
    // $14 at price 10 with step 1 → rounds down to 1 unit = $10.
    expect(quantiseNotional(14, 10, 1, 5).notionalUsd).toBe(10);
    // Rounds down below the venue minimum → refuse.
    expect(quantiseNotional(9, 10, 1, 5)).toEqual({ qty: 0, notionalUsd: 0 });
  });
});

/* ------------------------------------------------------------------ tiers */

describe("capital ladder", () => {
  it("maps NAV to the right tier", () => {
    expect(tierForNav(0).id).toBe("T0");
    expect(tierForNav(499).id).toBe("T0");
    expect(tierForNav(500).id).toBe("T1");
    expect(tierForNav(9_999).id).toBe("T2");
    expect(tierForNav(1_000_000).id).toBe("T5");
  });

  it("withholds promotion until the hold period is met", () => {
    const s = resolveTier(3_000, 3, "T1");
    expect(s.current.id).toBe("T1");
    expect(s.implied.id).toBe("T2");
    expect(s.awaitingPromotion).toBe(true);
    expect(s.daysUntilPromotion).toBe(PROMOTION_HOLD_DAYS - 3);
  });

  it("promotes once the hold period is satisfied", () => {
    const s = resolveTier(3_000, PROMOTION_HOLD_DAYS, "T1");
    expect(s.current.id).toBe("T2");
    expect(s.awaitingPromotion).toBe(false);
  });

  it("demotes immediately with no grace period", () => {
    // The asymmetry is the point: protecting capital must not wait.
    const s = resolveTier(400, 0, "T2");
    expect(s.current.id).toBe("T0");
    expect(s.awaitingPromotion).toBe(false);
  });

  it("allocates nothing to high risk below T3", () => {
    expect(TIERS.find((t) => t.id === "T2")!.riskBudget.high).toBe(0);
    expect(TIERS.find((t) => t.id === "T3")!.riskBudget.high).toBeGreaterThan(0);
  });

  it("keeps T0 fully in shadow mode", () => {
    expect(TIERS[0].liveStrategies).toEqual([]);
  });

  it("reports where each strategy first unlocks", () => {
    expect(unlockTierFor("L1")).toBe("T1");
    expect(unlockTierFor("M3")).toBe("T4");
    expect(unlockTierFor("M4")).toBeNull(); // triangular is permanently shadow
  });
});

/* ------------------------------------------------------------------- gate */

const T2 = TIERS.find((t) => t.id === "T2")!;

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    strategyCode: "L1",
    strategyMode: "live",
    tier: T2,
    riskTier: "low",
    netEdgeBps: 40,
    minNetEdgeBps: 10,
    intendedNotionalUsd: 500,
    venueMinNotionalUsd: 5,
    minNotionalDragBps: 0,
    breakevenDays: 5,
    expectedHoldDays: 30,
    navUsd: 5_000,
    freeBalanceUsd: 2_000,
    capitalRequiredUsd: 667,
    openPositions: 0,
    riskTierDeployedUsd: 0,
    leverage: 3,
    maxLeverage: 5,
    venueHealthy: true,
    dataAgeSeconds: 2,
    maxDataAgeSeconds: 30,
    globalHalt: false,
    dailyLossLimitHit: false,
    ...over,
  };
}

describe("trade gate", () => {
  it("allows a clean opportunity", () => {
    const d = evaluateGate(gateInput());
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.sizedNotionalUsd).toBe(500);
  });

  it("reports global halt ahead of every other reason", () => {
    // Otherwise the operator goes tuning thresholds to fix a problem that
    // isn't there.
    const d = evaluateGate(
      gateInput({ globalHalt: true, netEdgeBps: -100, venueHealthy: false }),
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("global_halt");
  });

  it("blocks on stale market data", () => {
    const d = evaluateGate(gateInput({ dataAgeSeconds: 120, maxDataAgeSeconds: 30 }));
    if (!d.allowed) expect(d.code).toBe("market_data_stale");
    else throw new Error("expected rejection");
  });

  it("blocks a strategy that is not live-eligible at this tier", () => {
    const d = evaluateGate(gateInput({ strategyCode: "M3" }));
    if (!d.allowed) expect(d.code).toBe("strategy_tier_locked");
    else throw new Error("expected rejection");
  });

  it("blocks shadow-mode strategies from taking capital", () => {
    const d = evaluateGate(gateInput({ strategyMode: "shadow" }));
    if (!d.allowed) expect(d.code).toBe("strategy_disabled");
    else throw new Error("expected rejection");
  });

  it("rejects when min-notional drag eats the whole edge", () => {
    const d = evaluateGate(gateInput({ netEdgeBps: 25, minNotionalDragBps: 30 }));
    if (!d.allowed) expect(d.code).toBe("min_notional_drag");
    else throw new Error("expected rejection");
  });

  it("subtracts drag before comparing against the edge threshold", () => {
    const d = evaluateGate(
      gateInput({ netEdgeBps: 15, minNotionalDragBps: 8, minNetEdgeBps: 10 }),
    );
    if (!d.allowed) expect(d.code).toBe("net_edge_below_threshold");
    else throw new Error("expected rejection");
  });

  it("rejects a position that cannot repay its costs within the hold", () => {
    const d = evaluateGate(gateInput({ breakevenDays: 45, expectedHoldDays: 30 }));
    if (!d.allowed) expect(d.code).toBe("breakeven_exceeds_hold");
    else throw new Error("expected rejection");
  });

  it("enforces the concurrent position limit", () => {
    const d = evaluateGate(gateInput({ openPositions: T2.maxConcurrentPositions }));
    if (!d.allowed) expect(d.code).toBe("position_limit_reached");
    else throw new Error("expected rejection");
  });

  it("refuses risk tiers the capital tier allocates nothing to", () => {
    const d = evaluateGate(gateInput({ riskTier: "high" }));
    if (!d.allowed) expect(d.code).toBe("risk_budget_exhausted");
    else throw new Error("expected rejection");
  });

  it("sizes down to the remaining risk budget", () => {
    // Low budget at T2 is 65% of 5,000 = 3,250; 3,000 already deployed.
    const d = evaluateGate(
      gateInput({ riskTierDeployedUsd: 3_000, intendedNotionalUsd: 500 }),
    );
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.sizedNotionalUsd).toBeCloseTo(250, 6);
  });

  it("rejects when the post-limit size falls under the venue minimum", () => {
    const d = evaluateGate(
      gateInput({ riskTierDeployedUsd: 3_249, venueMinNotionalUsd: 10 }),
    );
    if (!d.allowed) expect(d.code).toBe("below_min_notional");
    else throw new Error("expected rejection");
  });

  it("blocks when capital required exceeds free balance", () => {
    const d = evaluateGate(gateInput({ freeBalanceUsd: 100, capitalRequiredUsd: 667 }));
    if (!d.allowed) expect(d.code).toBe("insufficient_balance");
    else throw new Error("expected rejection");
  });

  it("enforces the leverage cap", () => {
    const d = evaluateGate(gateInput({ leverage: 20, maxLeverage: 5 }));
    if (!d.allowed) expect(d.code).toBe("leverage_cap");
    else throw new Error("expected rejection");
  });
});
