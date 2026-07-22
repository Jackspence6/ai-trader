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
