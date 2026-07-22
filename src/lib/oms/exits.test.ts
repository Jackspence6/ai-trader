/**
 * Tests for the exit manager.
 *
 * The property that matters most: a carry exits as a WHOLE trade. The two
 * dangerous mistakes are closing a hedge's short leg while leaving the long
 * (a naked position), and never exiting an inverted carry at all (a slow bleed).
 * Both are asserted here with hand-set funding and P&L.
 */

import { describe, expect, it } from "vitest";
import type { MarkedPosition } from "@/lib/portfolio/positions";
import { evaluateExits } from "./exits";

function pos(over: Partial<MarkedPosition> = {}): MarkedPosition {
  const qty = over.qty ?? 1;
  return {
    key: "k",
    venue: "Binance",
    asset: "BTC",
    market: "perp",
    sleeveId: "core",
    qty,
    avgEntry: 100,
    realisedUsd: 0,
    feesUsd: 0,
    fundingUsd: 0,
    notionalUsd: Math.abs(qty) * 100,
    openedAt: 0,
    lastFillAt: 0,
    markPrice: 100,
    unrealisedUsd: 0,
    totalPnlUsd: 0,
    marketValueUsd: qty * 100,
    ...over,
  };
}

const NO_FX = { fxPair: () => undefined };

describe("exit manager — funding carry (L1)", () => {
  const carry = () => [
    pos({ market: "spot", qty: 1, asset: "BTC", sleeveId: "core" }),
    pos({ market: "perp", qty: -1, asset: "BTC", sleeveId: "core" }),
  ];

  it("holds while funding is still positive", () => {
    const plans = evaluateExits(carry(), {
      ...NO_FX,
      fundingApr: () => 0.1, // +10%, healthy
    });
    expect(plans).toHaveLength(0);
  });

  it("closes the whole trade when funding turns negative", () => {
    const plans = evaluateExits(carry(), {
      ...NO_FX,
      fundingApr: () => -0.02, // now paying
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].reason).toBe("funding_inverted");
    // BOTH legs close — never leave the spot leg naked.
    expect(plans[0].legs).toHaveLength(2);
  });

  it("holds through a negative print while the regime median is still positive", () => {
    // A single negative interval costs a couple of bp; re-entering costs the
    // full round trip. The regime, not the print, decides.
    const plans = evaluateExits(carry(), {
      ...NO_FX,
      fundingApr: () => -0.02,
      fundingMedianApr: () => 0.09,
    });
    expect(plans).toHaveLength(0);
  });

  it("closes when both the print and the regime median are negative", () => {
    const plans = evaluateExits(carry(), {
      ...NO_FX,
      fundingApr: () => -0.02,
      fundingMedianApr: () => -0.01,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].reason).toBe("funding_inverted");
  });

  it("falls back to the print alone when no history is available", () => {
    const plans = evaluateExits(carry(), {
      ...NO_FX,
      fundingApr: () => -0.02,
      fundingMedianApr: () => undefined,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].reason).toBe("funding_inverted");
  });
});

describe("exit manager — cross-venue spread (L2)", () => {
  const spread = () => [
    pos({ market: "perp", venue: "Bybit", qty: -1, asset: "ETH", sleeveId: "core" }),
    pos({ market: "perp", venue: "OKX", qty: 1, asset: "ETH", sleeveId: "core" }),
  ];

  it("holds while the spread is still positive", () => {
    const plans = evaluateExits(spread(), {
      ...NO_FX,
      // short Bybit funding richer than long OKX → spread positive
      fundingApr: (v) => (v === "Bybit" ? 0.15 : 0.02),
    });
    expect(plans).toHaveLength(0);
  });

  it("closes when the spread inverts", () => {
    const plans = evaluateExits(spread(), {
      ...NO_FX,
      fundingApr: (v) => (v === "Bybit" ? 0.02 : 0.15), // now upside-down
    });
    expect(plans[0].reason).toBe("spread_inverted");
  });
});

describe("exit manager — FX carry (F1)", () => {
  const fx = (qty: number) => [
    pos({ venue: "fx", market: "spot", asset: "USDZAR", sleeveId: "fx-carry", qty }),
  ];
  const pair = { fxPair: () => ({ base: "USD", quote: "ZAR" }) };

  it("holds a short USDZAR while the carry is intact", () => {
    // Short USDZAR = long ZAR (7.25%) vs USD (4.5%): +2.75% before swap, viable.
    const plans = evaluateExits(fx(-100), { ...pair, fundingApr: () => undefined });
    expect(plans).toHaveLength(0);
  });

  it("closes when holding the wrong (paying) side", () => {
    // Long USDZAR pays the differential — net carry deeply negative → exit.
    const plans = evaluateExits(fx(100), { ...pair, fundingApr: () => undefined });
    expect(plans[0].reason).toBe("fx_carry_decayed");
  });
});

describe("exit manager — stop loss", () => {
  it("closes any trade down more than the backstop, regardless of thesis", () => {
    // A $100-notional leg down $20 = −20% > the 12% stop, even with healthy funding.
    const plans = evaluateExits(
      [pos({ market: "perp", qty: -1, notionalUsd: 100, totalPnlUsd: -20 })],
      { ...NO_FX, fundingApr: () => 0.2 },
    );
    expect(plans[0].reason).toBe("stop_loss");
  });

  it("does not stop out on an unpriced leg it cannot assess", () => {
    const plans = evaluateExits(
      [pos({ market: "perp", qty: -1, totalPnlUsd: null, markPrice: null })],
      { ...NO_FX, fundingApr: () => 0.2 },
    );
    expect(plans).toHaveLength(0);
  });
});

describe("exit manager — FX trend (F2)", () => {
  const trendPos = (over: Partial<MarkedPosition> = {}) => [
    pos({
      venue: "fx",
      market: "spot",
      asset: "EURUSD",
      sleeveId: "fx-trend",
      qty: 300,
      notionalUsd: 30_000,
      marketValueUsd: 30_000,
      totalPnlUsd: 0,
      ...over,
    }),
  ];

  it("holds while the signal still points the held way", () => {
    const plans = evaluateExits(trendPos(), {
      ...NO_FX,
      fundingApr: () => undefined,
      fxTrend: () => "long",
      fxTrendStop: () => 0.02,
    });
    expect(plans).toHaveLength(0);
  });

  it("holds through a FLAT signal — a range is not a reversal", () => {
    const plans = evaluateExits(trendPos(), {
      ...NO_FX,
      fundingApr: () => undefined,
      fxTrend: () => "flat",
      fxTrendStop: () => 0.02,
    });
    expect(plans).toHaveLength(0);
  });

  it("closes when the signal flips against the position", () => {
    const plans = evaluateExits(trendPos(), {
      ...NO_FX,
      fundingApr: () => undefined,
      fxTrend: () => "short",
      fxTrendStop: () => 0.02,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].reason).toBe("trend_flipped");
  });

  it("closes on the volatility stop before the generic backstop", () => {
    // Down 2.5% of notional with a 2% stop: the vol stop fires long before
    // the 12% backstop would.
    const plans = evaluateExits(trendPos({ totalPnlUsd: -750 }), {
      ...NO_FX,
      fundingApr: () => undefined,
      fxTrend: () => "long",
      fxTrendStop: () => 0.02,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].reason).toBe("trend_stopped");
  });

  it("does not apply the carry-decay rule to a trend position", () => {
    // A short EURUSD trend position with positive EUR carry would look like a
    // "decayed carry" to the carry rule — but it is not a carry trade.
    const plans = evaluateExits(trendPos({ qty: -300 }), {
      fundingApr: () => undefined,
      fxPair: () => ({ base: "EUR", quote: "USD" }),
      fxTrend: () => "short",
      fxTrendStop: () => 0.02,
    });
    expect(plans).toHaveLength(0);
  });
});

describe("exit manager — stablecoin peg (L3)", () => {
  const peg = (over: Partial<MarkedPosition> = {}) => [
    pos({
      venue: "Binance",
      market: "spot",
      asset: "USDC",
      sleeveId: "core",
      qty: 2000,
      notionalUsd: 1980,
      totalPnlUsd: 0,
      ...over,
    }),
  ];

  it("holds while the discount persists", () => {
    const plans = evaluateExits(peg(), {
      ...NO_FX,
      fundingApr: () => undefined,
      stableDiscount: () => 0.01, // still 1% below par
    });
    expect(plans).toHaveLength(0);
  });

  it("closes when the peg restores", () => {
    const plans = evaluateExits(peg(), {
      ...NO_FX,
      fundingApr: () => undefined,
      stableDiscount: () => 0.0001, // back to par, within dust
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].reason).toBe("peg_restored");
  });

  it("does not confuse a stable position with a crypto carry", () => {
    // A spot-only stable group must never reach the perp-based carry rules,
    // and healthy funding elsewhere must not hold it open past the repeg.
    const plans = evaluateExits(peg(), {
      ...NO_FX,
      fundingApr: () => 0.5,
      stableDiscount: () => 0.0001,
    });
    expect(plans[0].reason).toBe("peg_restored");
  });
});
