/**
 * Tests for position and PnL accounting.
 *
 * Every assertion here is hand-computable. Sign errors in this file are silent
 * — they do not throw, they just make the system confidently wrong about what
 * it holds and what it made — so the arithmetic is spelled out in each case.
 *
 * The flip case gets the most attention. Treating a fill larger than the
 * position as a simple add corrupts both the average entry and every
 * subsequent PnL number, and it is the bug most likely to survive review.
 */

import { describe, expect, it } from "vitest";
import {
  applyFill,
  assetDelta,
  buildPositions,
  capitalConsumedUsd,
  countLogicalPositions,
  markPositions,
  sleevePnl,
  type Fill,
} from "./positions";

let seq = 0;
function fill(over: Partial<Fill> = {}): Fill {
  seq += 1;
  return {
    id: `f${seq}`,
    ts: 1_000 + seq,
    venue: "binance",
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

describe("applyFill", () => {
  it("opens a long", () => {
    const p = applyFill(null, fill({ side: "buy", qty: 2, price: 100 }));
    expect(p.qty).toBe(2);
    expect(p.avgEntry).toBe(100);
    expect(p.realisedUsd).toBe(0);
    expect(p.notionalUsd).toBe(200);
  });

  it("opens a short with negative quantity", () => {
    const p = applyFill(null, fill({ side: "sell", qty: 2, price: 100 }));
    expect(p.qty).toBe(-2);
    expect(p.avgEntry).toBe(100);
  });

  it("books no PnL when adding to a position", () => {
    // Buying more of something does not make or lose money.
    let p = applyFill(null, fill({ side: "buy", qty: 1, price: 100 }));
    p = applyFill(p, fill({ side: "buy", qty: 1, price: 200 }));
    expect(p.qty).toBe(2);
    expect(p.avgEntry).toBe(150); // (100 + 200) / 2
    expect(p.realisedUsd).toBe(0);
  });

  it("weights average entry by quantity, not by fill count", () => {
    let p = applyFill(null, fill({ side: "buy", qty: 1, price: 100 }));
    p = applyFill(p, fill({ side: "buy", qty: 3, price: 200 }));
    // (1×100 + 3×200) / 4 = 175, not (100+200)/2 = 150
    expect(p.avgEntry).toBe(175);
  });

  it("books profit when a long is reduced above entry", () => {
    let p = applyFill(null, fill({ side: "buy", qty: 2, price: 100 }));
    p = applyFill(p, fill({ side: "sell", qty: 1, price: 150 }));
    expect(p.qty).toBe(1);
    expect(p.realisedUsd).toBe(50); // 1 × (150 − 100)
    // Average entry is UNCHANGED — the remaining unit was bought at 100.
    expect(p.avgEntry).toBe(100);
  });

  it("books a loss when a long is reduced below entry", () => {
    let p = applyFill(null, fill({ side: "buy", qty: 2, price: 100 }));
    p = applyFill(p, fill({ side: "sell", qty: 1, price: 80 }));
    expect(p.realisedUsd).toBe(-20);
  });

  it("books profit when a SHORT is reduced below entry", () => {
    // The sign case most likely to be wrong: a short makes money when price
    // falls, so buying back cheaper is a profit.
    let p = applyFill(null, fill({ side: "sell", qty: 2, price: 100 }));
    p = applyFill(p, fill({ side: "buy", qty: 1, price: 80 }));
    expect(p.qty).toBe(-1);
    expect(p.realisedUsd).toBe(20); // 1 × (100 − 80)
  });

  it("books a loss when a short is covered above entry", () => {
    let p = applyFill(null, fill({ side: "sell", qty: 1, price: 100 }));
    p = applyFill(p, fill({ side: "buy", qty: 1, price: 130 }));
    expect(p.qty).toBe(0);
    expect(p.realisedUsd).toBe(-30);
  });

  it("closes flat exactly", () => {
    let p = applyFill(null, fill({ side: "buy", qty: 2, price: 100 }));
    p = applyFill(p, fill({ side: "sell", qty: 2, price: 110 }));
    expect(p.qty).toBe(0);
    expect(p.realisedUsd).toBe(20);
  });

  it("FLIPS correctly — books PnL only on the closed portion", () => {
    // Long 1 @ 100, then sell 3 @ 150.
    //   Closed portion: 1 × (150 − 100) = +50 realised
    //   Remaining:      short 2, entered at 150 (NOT at 100)
    let p = applyFill(null, fill({ side: "buy", qty: 1, price: 100 }));
    p = applyFill(p, fill({ side: "sell", qty: 3, price: 150 }));

    expect(p.qty).toBe(-2);
    expect(p.realisedUsd).toBe(50);
    expect(p.avgEntry).toBe(150);
  });

  it("flips from short to long correctly", () => {
    // Short 2 @ 100, then buy 5 @ 80.
    //   Closed: 2 × (100 − 80) = +40
    //   Remaining: long 3 @ 80
    let p = applyFill(null, fill({ side: "sell", qty: 2, price: 100 }));
    p = applyFill(p, fill({ side: "buy", qty: 5, price: 80 }));

    expect(p.qty).toBe(3);
    expect(p.realisedUsd).toBe(40);
    expect(p.avgEntry).toBe(80);
  });

  it("accumulates fees on every fill in both directions", () => {
    let p = applyFill(null, fill({ side: "buy", qty: 1, price: 100, feeUsd: 0.1 }));
    p = applyFill(p, fill({ side: "sell", qty: 1, price: 100, feeUsd: 0.1 }));
    expect(p.feesUsd).toBeCloseTo(0.2, 10);
  });

  it("preserves realised PnL when reopening after going flat", () => {
    let p = applyFill(null, fill({ side: "buy", qty: 1, price: 100 }));
    p = applyFill(p, fill({ side: "sell", qty: 1, price: 120 })); // +20, now flat
    p = applyFill(p, fill({ side: "buy", qty: 1, price: 90 })); // reopen
    expect(p.qty).toBe(1);
    expect(p.avgEntry).toBe(90);
    expect(p.realisedUsd).toBe(20);
  });
});

describe("buildPositions", () => {
  it("sorts fills by time before applying them", () => {
    // Out-of-order application produces a wrong average entry, and venues do
    // deliver fills out of order.
    const a = fill({ ts: 2000, side: "buy", qty: 1, price: 200 });
    const b = fill({ ts: 1000, side: "buy", qty: 1, price: 100 });
    const [p] = buildPositions([a, b]);
    expect(p.avgEntry).toBe(150);
    expect(p.openedAt).toBe(1000);
  });

  it("keeps positions separate by sleeve", () => {
    // Two sleeves holding the same asset must not net against each other —
    // that would make one sleeve's loss cancel another's gain and destroy the
    // isolation the whole design rests on.
    const ps = buildPositions([
      fill({ sleeveId: "core", side: "buy", qty: 1 }),
      fill({ sleeveId: "systematic", side: "sell", qty: 1 }),
    ]);
    expect(ps).toHaveLength(2);
    expect(ps.find((p) => p.sleeveId === "core")!.qty).toBe(1);
    expect(ps.find((p) => p.sleeveId === "systematic")!.qty).toBe(-1);
  });

  it("keeps spot and perp separate on the same asset", () => {
    // This separation is what makes a carry position legible: +1 spot and
    // −1 perp are two positions that net to zero delta, not one flat position.
    const ps = buildPositions([
      fill({ market: "spot", side: "buy", qty: 1 }),
      fill({ market: "perp", side: "sell", qty: 1 }),
    ]);
    expect(ps).toHaveLength(2);
  });

  it("attaches funding to the matching perp position", () => {
    const ps = buildPositions(
      [fill({ market: "perp", side: "sell", qty: 1 })],
      [
        {
          id: "fp1",
          ts: 2000,
          venue: "binance",
          asset: "BTC",
          amountUsd: 1.25,
          sleeveId: "core",
        },
      ],
    );
    expect(ps[0].fundingUsd).toBe(1.25);
  });

  it("ignores funding with no matching position rather than throwing", () => {
    const ps = buildPositions(
      [fill({ market: "perp", asset: "BTC" })],
      [
        {
          id: "fp1",
          ts: 2000,
          venue: "binance",
          asset: "ETH",
          amountUsd: 5,
          sleeveId: "core",
        },
      ],
    );
    expect(ps[0].fundingUsd).toBe(0);
  });

  it("returns nothing for an empty fill stream", () => {
    expect(buildPositions([])).toEqual([]);
  });
});

describe("marking to market", () => {
  it("computes unrealised PnL for a long", () => {
    const ps = buildPositions([fill({ side: "buy", qty: 2, price: 100 })]);
    const [m] = markPositions(ps, new Map([["BTC", 120]]));
    expect(m.unrealisedUsd).toBe(40); // 2 × (120 − 100)
    expect(m.marketValueUsd).toBe(240);
  });

  it("computes unrealised PnL for a short", () => {
    const ps = buildPositions([fill({ side: "sell", qty: 2, price: 100 })]);
    const [m] = markPositions(ps, new Map([["BTC", 80]]));
    // qty is −2, so −2 × (80 − 100) = +40
    expect(m.unrealisedUsd).toBe(40);
  });

  it("returns NULL, not zero, for an unpriceable position", () => {
    // Zero reads as "flat", which is a specific and wrong claim. Null reads as
    // "unknown", which is the truth.
    const ps = buildPositions([fill({ asset: "WEIRD", side: "buy", qty: 1 })]);
    const [m] = markPositions(ps, new Map());
    expect(m.unrealisedUsd).toBeNull();
    expect(m.totalPnlUsd).toBeNull();
  });

  it("totals realised, unrealised, funding and fees together", () => {
    const ps = buildPositions(
      [
        fill({ side: "buy", qty: 2, price: 100, feeUsd: 1 }),
        fill({ side: "sell", qty: 1, price: 150, feeUsd: 1 }),
      ],
      [{ id: "fp", ts: 3000, venue: "binance", asset: "BTC", amountUsd: 3, sleeveId: "core" }],
    );
    const [m] = markPositions(ps, new Map([["BTC", 200]]));
    // realised 50, unrealised 1×(200−100)=100, funding +3, fees 2
    expect(m.realisedUsd).toBe(50);
    expect(m.unrealisedUsd).toBe(100);
    expect(m.totalPnlUsd).toBe(50 + 100 + 3 - 2);
  });
});

describe("sleeve PnL", () => {
  it("aggregates per sleeve and keeps them independent", () => {
    const ps = buildPositions([
      fill({ sleeveId: "core", side: "buy", qty: 1, price: 100 }),
      fill({ sleeveId: "systematic", side: "buy", qty: 1, price: 100 }),
    ]);
    const marked = markPositions(ps, new Map([["BTC", 110]]));
    const pnl = sleevePnl(marked);

    expect(pnl).toHaveLength(2);
    for (const s of pnl) expect(s.unrealisedUsd).toBe(10);
  });

  it("reports a sleeve total as unknown when any position is unpriceable", () => {
    // Summing the priceable ones would understate the sleeve while looking
    // precise — the worst combination.
    const ps = buildPositions([
      fill({ sleeveId: "core", asset: "BTC", side: "buy", qty: 1, price: 100 }),
      fill({ sleeveId: "core", asset: "WEIRD", side: "buy", qty: 1, price: 100 }),
    ]);
    const marked = markPositions(ps, new Map([["BTC", 110]]));
    const [s] = sleevePnl(marked);
    expect(s.unrealisedUsd).toBeNull();
    expect(s.totalUsd).toBeNull();
    expect(s.grossExposureUsd).toBeNull();
  });

  it("distinguishes gross from net exposure", () => {
    const ps = buildPositions([
      fill({ sleeveId: "core", market: "spot", side: "buy", qty: 1, price: 100 }),
      fill({ sleeveId: "core", market: "perp", side: "sell", qty: 1, price: 100 }),
    ]);
    const marked = markPositions(ps, new Map([["BTC", 100]]));
    const [s] = sleevePnl(marked);
    // A hedged carry position: 200 gross, 0 net.
    expect(s.grossExposureUsd).toBe(200);
    expect(s.netExposureUsd).toBe(0);
  });

  it("counts only open positions", () => {
    const ps = buildPositions([
      fill({ side: "buy", qty: 1, price: 100 }),
      fill({ side: "sell", qty: 1, price: 110 }),
    ]);
    const [s] = sleevePnl(markPositions(ps, new Map([["BTC", 110]])));
    expect(s.openPositions).toBe(0);
    expect(s.realisedUsd).toBe(10);
  });
});

describe("asset delta", () => {
  it("nets a delta-neutral carry to zero", () => {
    // The number that proves "delta-neutral" actually is. If this is not zero,
    // the hedge has slipped and the position is quietly directional.
    const ps = buildPositions([
      fill({ market: "spot", side: "buy", qty: 1 }),
      fill({ market: "perp", side: "sell", qty: 1 }),
    ]);
    const delta = assetDelta(markPositions(ps, new Map([["BTC", 100]])));
    expect(delta.get("BTC")).toBe(0);
  });

  it("exposes a slipped hedge as a non-zero delta", () => {
    const ps = buildPositions([
      fill({ market: "spot", side: "buy", qty: 1 }),
      fill({ market: "perp", side: "sell", qty: 0.8 }),
    ]);
    const delta = assetDelta(markPositions(ps, new Map([["BTC", 100]])));
    expect(delta.get("BTC")).toBeCloseTo(0.2, 10);
  });

  it("sums across sleeves, because market risk does not respect our bookkeeping", () => {
    const ps = buildPositions([
      fill({ sleeveId: "core", side: "buy", qty: 1 }),
      fill({ sleeveId: "systematic", side: "buy", qty: 2 }),
    ]);
    const delta = assetDelta(markPositions(ps, new Map([["BTC", 100]])));
    expect(delta.get("BTC")).toBe(3);
  });
});

describe("logical position counting", () => {
  it("counts a two-leg carry as ONE position, not two", () => {
    // The bug this exists to prevent: counting legs makes a single carry look
    // like two positions, so a limit of 1 permits half a carry and then blocks
    // everything forever. It silently froze the paper book after one trade.
    const ps = buildPositions([
      fill({ market: "spot", side: "buy", qty: 1, asset: "BTC" }),
      fill({ market: "perp", side: "sell", qty: 1, asset: "BTC" }),
    ]);
    expect(ps).toHaveLength(2); // two legs
    expect(countLogicalPositions(ps)).toBe(1); // one trade
  });

  it("counts different assets separately", () => {
    const ps = buildPositions([
      fill({ market: "spot", side: "buy", asset: "BTC" }),
      fill({ market: "perp", side: "sell", asset: "BTC" }),
      fill({ market: "spot", side: "buy", asset: "ETH" }),
      fill({ market: "perp", side: "sell", asset: "ETH" }),
    ]);
    expect(countLogicalPositions(ps)).toBe(2);
  });

  it("counts the same asset in different sleeves separately", () => {
    // Sleeves are separately mandated books; a BTC carry in Core and one in
    // Systematic are two decisions, not one.
    const ps = buildPositions([
      fill({ sleeveId: "core", side: "buy", asset: "BTC" }),
      fill({ sleeveId: "systematic", side: "buy", asset: "BTC" }),
    ]);
    expect(countLogicalPositions(ps)).toBe(2);
  });

  it("ignores closed legs", () => {
    const ps = buildPositions([
      fill({ side: "buy", qty: 1, price: 100 }),
      fill({ side: "sell", qty: 1, price: 110 }),
    ]);
    expect(countLogicalPositions(ps)).toBe(0);
  });

  it("counts a cross-venue spread on one asset as one position", () => {
    // Two perp legs on different venues are still one trade.
    const ps = buildPositions([
      fill({ venue: "bybit", market: "perp", side: "sell", asset: "LINK" }),
      fill({ venue: "hyperliquid", market: "perp", side: "buy", asset: "LINK" }),
    ]);
    expect(countLogicalPositions(ps)).toBe(1);
  });
});

describe("capitalConsumedUsd", () => {
  const prices = new Map([["BTC", 100], ["EURUSD", 100]]);
  const lev = () => 3;

  it("charges a funding carry the entry-gate measure: spot in full, perp at margin", () => {
    // 1 BTC spot at $100 + 1 BTC perp short at 3x → 100 + 100/3, not 200.
    const marked = markPositions(
      buildPositions([
        fill({ market: "spot", side: "buy" }),
        fill({ market: "perp", side: "sell" }),
      ]),
      prices,
    );
    expect(capitalConsumedUsd(marked, lev)).toBeCloseTo(100 + 100 / 3);
  });

  it("charges a cross-venue spread margin on both perp legs", () => {
    const marked = markPositions(
      buildPositions([
        fill({ venue: "bybit", market: "perp", side: "sell" }),
        fill({ venue: "okx", market: "perp", side: "buy" }),
      ]),
      prices,
    );
    expect(capitalConsumedUsd(marked, lev)).toBeCloseTo(200 / 3);
  });

  it("treats FX spot as margined, at the sleeve's own leverage", () => {
    const marked = markPositions(
      buildPositions([
        fill({ venue: "fx", market: "spot", side: "buy", asset: "EURUSD", sleeveId: "fx-carry" }),
      ]),
      prices,
    );
    const leverageFor = (id: string) => (id === "fx-carry" ? 2 : 3);
    expect(capitalConsumedUsd(marked, leverageFor)).toBeCloseTo(50);
  });

  it("falls back to entry notional when a leg has no mark", () => {
    const marked = markPositions(
      buildPositions([fill({ market: "spot", side: "buy", asset: "NOPRICE" })]),
      prices,
    );
    expect(marked[0].marketValueUsd).toBeNull();
    expect(capitalConsumedUsd(marked, lev)).toBeCloseTo(100);
  });

  it("never divides by a leverage below 1 and ignores flat legs", () => {
    const marked = markPositions(
      buildPositions([
        fill({ market: "perp", side: "buy", qty: 1 }),
        fill({ market: "perp", side: "sell", qty: 1 }),
      ]),
      prices,
    );
    expect(capitalConsumedUsd(marked, () => 0)).toBe(0);
  });
});
