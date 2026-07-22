/**
 * Tests for trade reconstruction.
 *
 * The subtle property: a carry is ONE trade, not two. Its spot and perp legs
 * live under the same (sleeve, asset), so an episode opens when the pair leaves
 * flat and closes only when the pair returns flat — reconstructing two separate
 * trades from a hedged pair would double the trade count and halve every average.
 */

import { describe, expect, it } from "vitest";
import type { Fill, FundingPayment } from "./positions";
import { reconstructTrades, tradeStats } from "./trades";

let seq = 0;
function fill(over: Partial<Fill> = {}): Fill {
  seq += 1;
  return {
    id: `f${seq}`,
    ts: seq * 1000,
    venue: "Binance",
    asset: "BTC",
    market: "perp",
    side: "buy",
    qty: 1,
    price: 100,
    feeUsd: 0,
    sleeveId: "core",
    strategy: "L1",
    orderId: `o${seq}`,
    ...over,
  };
}

describe("reconstructTrades", () => {
  it("pairs an open and a close into one completed trade", () => {
    const { completed, open } = reconstructTrades([
      fill({ ts: 1000, side: "buy", qty: 1, price: 100 }),
      fill({ ts: 5000, side: "sell", qty: 1, price: 110, feeUsd: 1 }),
    ]);
    expect(open).toHaveLength(0);
    expect(completed).toHaveLength(1);
    const t = completed[0];
    expect(t.realisedUsd).toBeCloseTo(10, 6); // (110−100)×1
    expect(t.feesUsd).toBeCloseTo(1, 6);
    expect(t.netUsd).toBeCloseTo(9, 6);
    expect(t.win).toBe(true);
    expect(t.durationMs).toBe(4000);
  });

  it("treats a two-leg carry as a single trade", () => {
    // Long spot + short perp, then close both. One (core, BTC) episode.
    const { completed } = reconstructTrades([
      fill({ ts: 1000, market: "spot", side: "buy", qty: 1, price: 100 }),
      fill({ ts: 1000, market: "perp", side: "sell", qty: 1, price: 100 }),
      fill({ ts: 9000, market: "spot", side: "sell", qty: 1, price: 100 }),
      fill({ ts: 9000, market: "perp", side: "buy", qty: 1, price: 100 }),
    ]);
    expect(completed).toHaveLength(1);
    expect(completed[0].asset).toBe("BTC");
  });

  it("attributes funding earned while the trade was open", () => {
    const funding: FundingPayment[] = [
      { id: "p1", ts: 3000, venue: "Binance", asset: "BTC", amountUsd: 4, sleeveId: "core" },
    ];
    const { completed } = reconstructTrades(
      [
        fill({ ts: 1000, side: "buy", qty: 1, price: 100 }),
        fill({ ts: 5000, side: "sell", qty: 1, price: 100 }),
      ],
      funding,
    );
    expect(completed[0].fundingUsd).toBeCloseTo(4, 6);
    expect(completed[0].netUsd).toBeCloseTo(4, 6); // 0 price P&L + 4 funding
    expect(completed[0].win).toBe(true);
  });

  it("reports a still-open position as an open trade", () => {
    const { completed, open } = reconstructTrades([
      fill({ ts: 1000, side: "buy", qty: 1, price: 100 }),
    ]);
    expect(completed).toHaveLength(0);
    expect(open).toHaveLength(1);
    expect(open[0].legs).toBe(1);
  });

  it("separates two sequential episodes on the same key", () => {
    const { completed } = reconstructTrades([
      fill({ ts: 1000, side: "buy", qty: 1, price: 100 }),
      fill({ ts: 2000, side: "sell", qty: 1, price: 105 }), // close #1
      fill({ ts: 3000, side: "buy", qty: 1, price: 105 }),
      fill({ ts: 4000, side: "sell", qty: 1, price: 103 }), // close #2 (loss)
    ]);
    expect(completed).toHaveLength(2);
    // Newest first.
    expect(completed[0].win).toBe(false);
    expect(completed[1].win).toBe(true);
  });
});

describe("tradeStats", () => {
  it("summarises win rate, expectancy and profit factor", () => {
    const { completed } = reconstructTrades([
      fill({ ts: 1000, side: "buy", qty: 1, price: 100 }),
      fill({ ts: 2000, side: "sell", qty: 1, price: 110 }), // +10
      fill({ ts: 3000, side: "buy", qty: 1, price: 110 }),
      fill({ ts: 4000, side: "sell", qty: 1, price: 105 }), // −5
    ]);
    const s = tradeStats(completed);
    expect(s.count).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.winRate).toBeCloseTo(0.5, 6);
    expect(s.totalNetUsd).toBeCloseTo(5, 6);
    expect(s.expectancyUsd).toBeCloseTo(2.5, 6);
    expect(s.profitFactor).toBeCloseTo(10 / 5, 6);
  });

  it("handles an empty history without dividing by zero", () => {
    const s = tradeStats([]);
    expect(s.count).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.profitFactor).toBeNull();
  });
});
