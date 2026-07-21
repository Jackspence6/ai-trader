/**
 * Tests for the OMS and paper-trading engine.
 *
 * The property that matters most: **the simulator must be pessimistic.** A
 * paper venue that fills at mid with no costs produces beautiful equity curves
 * and teaches you nothing — it is the same failure DESIGN.md §9 warns about for
 * backtesters, where a simulator that lies manufactures confidence.
 *
 * So the assertions below check that buys fill ABOVE mid, sells fill BELOW,
 * fees are always a cost, and a bigger order fills worse than a small one.
 */

import { describe, expect, it } from "vitest";
import { SimulatedVenue, booksFromQuotes } from "./simulated";
import { runPaperPass, edgeAccuracy, type PaperDecision } from "./paper";
import { buildPositions, markPositions } from "@/lib/portfolio/positions";
import { DEFAULT_CONFIG, type EngineConfig } from "@/lib/engine/config";
import type { OrderIntent } from "./types";
import type { ScoredOpportunity } from "@/lib/engine/scanner";

const BOOK = {
  asset: "BTC",
  venue: "binance",
  market: "spot" as const,
  bid: 99.95,
  ask: 100.05,
  spreadBps: 10,
  topOfBookUsd: 1_000_000,
};

function venueWithBook(over: Partial<typeof BOOK> = {}) {
  const v = new SimulatedVenue();
  v.setBooks([{ ...BOOK, ...over }]);
  return v;
}

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: "i1",
    ts: 1000,
    venue: "binance",
    asset: "BTC",
    market: "spot",
    side: "buy",
    qty: 1,
    type: "market",
    timeInForce: "IOC",
    sleeveId: "core",
    strategy: "L1",
    rationale: "test",
    ...over,
  };
}

describe("simulated venue", () => {
  it("is not live, and says so", () => {
    expect(new SimulatedVenue().isLive).toBe(false);
  });

  it("fills a BUY above mid", async () => {
    // Crossing the spread costs money. A buy that fills at or below mid is a
    // simulator flattering itself.
    const v = venueWithBook();
    const r = await v.submit(intent({ side: "buy" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills[0].price).toBeGreaterThan(100);
  });

  it("fills a SELL below mid", async () => {
    const v = venueWithBook();
    const r = await v.submit(intent({ side: "sell" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills[0].price).toBeLessThan(100);
  });

  it("charges a fee on every fill", async () => {
    const v = venueWithBook();
    const r = await v.submit(intent());
    if (!r.ok) throw new Error("expected fill");
    expect(r.fills[0].feeUsd).toBeGreaterThan(0);
  });

  it("fills a large order worse than a small one", async () => {
    // Square-root impact. If size did not degrade the fill, the simulator would
    // imply infinite liquidity and every strategy would look scalable.
    const v = venueWithBook({ topOfBookUsd: 10_000 });
    const small = await v.submit(intent({ qty: 1 }));
    const large = await v.submit(intent({ qty: 50 }));
    if (!small.ok || !large.ok) throw new Error("expected fills");
    expect(large.fills[0].price).toBeGreaterThan(small.fills[0].price);
  });

  it("punishes a thin book harder than a deep one", async () => {
    const deep = venueWithBook({ topOfBookUsd: 10_000_000 });
    const thin = venueWithBook({ topOfBookUsd: 5_000 });
    const a = await deep.submit(intent({ qty: 10 }));
    const b = await thin.submit(intent({ qty: 10 }));
    if (!a.ok || !b.ok) throw new Error("expected fills");
    expect(b.fills[0].price).toBeGreaterThan(a.fills[0].price);
  });

  it("refuses to fill when it has no market data", async () => {
    // Inventing a price when we do not know one is exactly the lie the
    // simulator exists to avoid.
    const v = new SimulatedVenue();
    const r = await v.submit(intent());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/No market data/);
  });

  it("refuses an order below the venue minimum", async () => {
    const v = venueWithBook();
    const r = await v.submit(intent({ qty: 0.01 })); // $1 notional
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/below venue minimum/);
  });

  it("refuses a non-positive quantity", async () => {
    const v = venueWithBook();
    expect((await v.submit(intent({ qty: 0 }))).ok).toBe(false);
    expect((await v.submit(intent({ qty: -1 }))).ok).toBe(false);
  });

  it("records a latency breakdown on every order", async () => {
    // DESIGN.md §8.5 — this cannot be reconstructed after the fact.
    const v = venueWithBook();
    const r = await v.submit(intent());
    if (!r.ok) throw new Error("expected fill");
    expect(r.order.timings.acknowledgedMs).toBeGreaterThan(0);
    expect(r.order.timings.completeMs).toBeGreaterThan(0);
  });

  it("has nothing resting, since every accepted order fills", async () => {
    const v = venueWithBook();
    await v.submit(intent());
    expect(await v.openOrders()).toEqual([]);
  });

  it("refuses to cancel an already-filled order", async () => {
    const v = venueWithBook();
    const r = await v.submit(intent());
    if (!r.ok) throw new Error("expected fill");
    const c = await v.cancel(r.order.id);
    expect(c.ok).toBe(false);
  });

  it("round-trips a position at a LOSS after costs", async () => {
    // The headline property. Buy and immediately sell at an unchanged price
    // and you must be down — spread twice plus fees twice. A simulator where
    // this breaks even would make every strategy look free to trade.
    const v = venueWithBook();
    const buy = await v.submit(intent({ side: "buy", qty: 1 }));
    const sell = await v.submit(intent({ side: "sell", qty: 1 }));
    if (!buy.ok || !sell.ok) throw new Error("expected fills");

    const positions = buildPositions([...buy.fills, ...sell.fills]);
    const [marked] = markPositions(positions, new Map([["BTC", 100]]));

    expect(marked.qty).toBe(0);
    expect(marked.totalPnlUsd).toBeLessThan(0);
  });

  it("builds books from live quotes, skipping unpriced ones", () => {
    const books = booksFromQuotes([
      { venue: "binance", asset: "BTC", kind: "spot", bid: 100, ask: 101, spreadBps: 10, topOfBookUsd: 1000 },
      { venue: "binance", asset: "NOPE", kind: "spot", bid: 0, ask: 0, spreadBps: 0, topOfBookUsd: 0 },
    ]);
    expect(books).toHaveLength(1);
    expect(books[0].asset).toBe("BTC");
  });
});

/* ------------------------------------------------------------ paper engine */

function opportunity(over: Partial<ScoredOpportunity> = {}): ScoredOpportunity {
  return {
    id: "L1-Binance-BTC",
    ts: Date.now(),
    strategy: "L1",
    strategyName: "Funding carry",
    asset: "BTC",
    route: "Binance spot ⇄ Binance perp",
    riskTier: "low",
    sleeveId: "core",
    sleeveName: "Core",
    grossBps: 60,
    feesBps: 10,
    spreadBps: 5,
    slippageBps: 2,
    dragBps: 0,
    netBps: 40,
    netApr: 0.12,
    breakevenDays: 5,
    capitalRequiredUsd: 1333,
    notionalUsd: 1000,
    expectedProfitUsd: 4,
    fundingApr: 0.11,
    taken: false,
    wouldTake: true,
    rejectionCode: null,
    rejectionDetail: null,
    ...over,
  };
}

function config(over: Partial<EngineConfig> = {}): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    navUsd: 10_000,
    sleeves: DEFAULT_CONFIG.sleeves.map((s) =>
      s.sleeveId === "core" ? { ...s, allocatedUsd: 5_000, enabled: true } : s,
    ),
    ...over,
  };
}

function paperVenue() {
  const v = new SimulatedVenue();
  v.setBooks([
    { asset: "BTC", venue: "Binance", market: "spot", bid: 99.95, ask: 100.05, spreadBps: 10, topOfBookUsd: 5_000_000 },
    { asset: "BTC", venue: "Binance", market: "perp", bid: 99.95, ask: 100.05, spreadBps: 10, topOfBookUsd: 5_000_000 },
    { asset: "BTC", venue: "Bybit", market: "perp", bid: 99.95, ask: 100.05, spreadBps: 10, topOfBookUsd: 5_000_000 },
    { asset: "BTC", venue: "Hyperliquid", market: "perp", bid: 99.9, ask: 100.1, spreadBps: 20, topOfBookUsd: 1_000_000 },
  ]);
  return v;
}

const PRICES = new Map([["BTC", 100]]);

describe("paper engine", () => {
  const base = {
    venue: paperVenue(),
    prices: PRICES,
    halted: false,
    dataAgeSeconds: 1,
    daysHeldAboveThreshold: 30,
  };

  it("executes a carry as TWO legs — long spot, short perp", async () => {
    // A carry modelled as one order is a directional position wearing a
    // market-neutral label.
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config(),
      opportunities: [opportunity()],
    });

    expect(r.executed).toBe(1);
    expect(r.fills).toHaveLength(2);
    const spot = r.fills.find((f) => f.market === "spot")!;
    const perp = r.fills.find((f) => f.market === "perp")!;
    expect(spot.side).toBe("buy");
    expect(perp.side).toBe("sell");
  });

  it("produces a delta-neutral position", async () => {
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config(),
      opportunities: [opportunity()],
    });
    const marked = markPositions(buildPositions(r.fills), PRICES);
    const net = marked.reduce((a, p) => a + p.qty, 0);
    expect(net).toBeCloseTo(0, 8);
  });

  it("runs its OWN gate rather than deferring to the scanner's live verdict", async () => {
    // The scanner's `wouldTake` is computed against the live gate, which blocks
    // on the capital tier. Filtering on it would make paper trading impossible
    // at T0 — the exact tier DESIGN.md §7 says should be producing paper PnL.
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config(),
      opportunities: [opportunity({ wouldTake: false })],
    });
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].executed).toBe(true);
  });

  it("still refuses an opportunity whose edge is below the threshold", async () => {
    // Considering everything does not mean accepting everything — the gate's
    // own economics check still applies.
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config({ minNetEdgeBps: 100 }),
      opportunities: [opportunity({ netBps: 5 })],
    });
    expect(r.executed).toBe(0);
    expect(r.decisions[0].rejectionCode).toBe("net_edge_below_threshold");
  });

  it("considers the best opportunities first", async () => {
    // When a sleeve runs out of room it should have run out on the best
    // opportunities, not on whichever happened to be first in the array.
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config(),
      opportunities: [
        opportunity({ id: "weak", netBps: 20 }),
        opportunity({ id: "strong", netBps: 80 }),
      ],
    });
    expect(r.decisions[0].opportunityId).toBe("strong");
  });

  it("refuses everything while halted", async () => {
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config(),
      opportunities: [opportunity()],
      halted: true,
    });
    expect(r.executed).toBe(0);
    expect(r.decisions[0].rejectionCode).toBe("global_halt");
  });

  it("refuses when the sleeve is disabled", async () => {
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config({
        sleeves: DEFAULT_CONFIG.sleeves.map((s) => ({ ...s, enabled: false, allocatedUsd: 5000 })),
      }),
      opportunities: [opportunity()],
    });
    expect(r.executed).toBe(0);
    expect(r.decisions[0].rejectionCode).toBe("sleeve_disabled");
  });

  it("sizes to the sleeve position cap, not to what was asked for", async () => {
    // Core caps a single position at 35% of sleeve capital. On $1,200 that is
    // $420, regardless of the $1,000 the opportunity requested.
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config({
        sleeves: DEFAULT_CONFIG.sleeves.map((s) =>
          s.sleeveId === "core" ? { ...s, allocatedUsd: 1_200, enabled: true } : s,
        ),
      }),
      opportunities: [opportunity({ notionalUsd: 1_000 })],
    });
    const leg = r.fills[0];
    expect(leg.qty * leg.price).toBeLessThanOrEqual(1_200 * 0.35 * 1.01);
  });

  it("accounts for earlier fills in the SAME pass", async () => {
    // Evaluating every intent against the opening state would let one sleeve
    // be filled several times over. The second entry must be smaller because
    // the first consumed sleeve headroom.
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config({
        sleeves: DEFAULT_CONFIG.sleeves.map((s) =>
          s.sleeveId === "core" ? { ...s, allocatedUsd: 1_200, enabled: true } : s,
        ),
      }),
      opportunities: [
        opportunity({ id: "a", notionalUsd: 1_000 }),
        opportunity({ id: "b", notionalUsd: 1_000 }),
      ],
    });

    const first = r.decisions[0].fills[0];
    const second = r.decisions[1].fills[0];
    expect(second.qty * second.price).toBeLessThan(first.qty * first.price);

    // And the sleeve is never overdrawn in total.
    const deployed = r.fills
      .filter((f) => f.market === "spot")
      .reduce((a, f) => a + f.qty * f.price, 0);
    expect(deployed).toBeLessThanOrEqual(1_200);
  });

  it("records realised entry cost for the predicted-vs-realised diagnostic", async () => {
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config(),
      opportunities: [opportunity()],
    });
    const d = r.decisions[0];
    expect(d.executed).toBe(true);
    expect(d.realisedEntryCostBps).toBeGreaterThan(0);
  });

  it("refuses an L2 route it cannot parse rather than guessing", async () => {
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config(),
      opportunities: [opportunity({ strategy: "L2", route: "nonsense route" })],
    });
    expect(r.decisions[0].rejectionCode).toBe("no_position_plan");
  });

  it("executes an L2 spread as two perp legs on different venues", async () => {
    const r = await runPaperPass({
      ...base,
      venue: paperVenue(),
      config: config(),
      opportunities: [
        opportunity({
          strategy: "L2",
          route: "Short Hyperliquid ⇄ Long Bybit",
        }),
      ],
    });
    expect(r.executed).toBe(1);
    expect(r.fills).toHaveLength(2);
    expect(r.fills.every((f) => f.market === "perp")).toBe(true);
    expect(new Set(r.fills.map((f) => f.venue)).size).toBe(2);
  });

  it("unwinds a partially-filled multi-leg entry", async () => {
    // A carry with the spot leg missing is a naked short. Leaving it open
    // would be worse than never entering.
    const v = new SimulatedVenue();
    // Only the spot book exists — the perp leg will be refused.
    v.setBooks([
      { asset: "BTC", venue: "Binance", market: "spot", bid: 99.95, ask: 100.05, spreadBps: 10, topOfBookUsd: 5_000_000 },
    ]);

    const r = await runPaperPass({
      ...base,
      venue: v,
      config: config(),
      opportunities: [opportunity()],
    });

    expect(r.executed).toBe(0);
    expect(r.decisions[0].rejectionCode).toBe("venue_rejected");
    expect(r.decisions[0].detail).toMatch(/unwound 1 filled leg/);
    // No net position survives the unwind.
    const marked = markPositions(buildPositions(v.allOrders().length ? r.fills : []), PRICES);
    expect(marked.reduce((a, p) => a + Math.abs(p.qty), 0)).toBe(0);
  });
});

describe("edge accuracy", () => {
  const decision = (over: Partial<PaperDecision> = {}): PaperDecision => ({
    opportunityId: "a",
    asset: "BTC",
    strategy: "L1",
    sleeveId: "core",
    executed: true,
    rejectionCode: null,
    detail: null,
    orders: [],
    fills: [],
    predictedNetBps: 40,
    predictedEntryCostBps: 8,
    realisedEntryCostBps: 12,
    ...over,
  });

  it("compares predicted COST against realised COST, not against net edge", () => {
    // Comparing realised cost to predicted net edge would compare a cost to a
    // profit — the resulting "error" would be noise dressed as a metric.
    const [acc] = edgeAccuracy([decision()]);
    expect(acc.samples).toBe(1);
    expect(acc.meanPredictedCostBps).toBe(8);
    expect(acc.meanRealisedCostBps).toBe(12);
    // Positive error means the cost model is optimistic and every threshold
    // derived from it is too loose.
    expect(acc.meanErrorBps).toBe(4);
  });

  it("reports a negative error when execution beat the model", () => {
    const [acc] = edgeAccuracy([
      decision({ predictedEntryCostBps: 20, realisedEntryCostBps: 12 }),
    ]);
    expect(acc.meanErrorBps).toBe(-8);
  });

  it("still surfaces predicted net edge alongside the cost comparison", () => {
    const [acc] = edgeAccuracy([decision()]);
    expect(acc.meanPredictedNetBps).toBe(40);
  });

  it("ignores unexecuted decisions", () => {
    expect(
      edgeAccuracy([
        decision({ executed: false, rejectionCode: "global_halt", realisedEntryCostBps: null }),
      ]),
    ).toEqual([]);
  });

  it("groups by strategy, since the cost models differ", () => {
    const accs = edgeAccuracy([decision({ strategy: "L1" }), decision({ strategy: "L2" })]);
    expect(accs.map((a) => a.strategy).sort()).toEqual(["L1", "L2"]);
  });
});
