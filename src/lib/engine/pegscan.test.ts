/**
 * Tests for the L3 stablecoin peg scan.
 *
 * The judgments that matter: a real discount clears the gate and sizes a buy;
 * a healthy peg produces silence, not noise rows; and a dust-sized deviation
 * is refused as uneconomic rather than traded into fees.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { defaultAllocations } from "@/lib/portfolio/sleeves";
import { resolveTier } from "@/lib/calc/tiers";
import type { Quote } from "@/lib/market/types";
import { scanStablePeg } from "./pegscan";

function stableQuote(over: Partial<Quote> = {}): Quote {
  const bid = over.bid ?? 0.9899;
  const ask = over.ask ?? 0.9901;
  return {
    venue: "Binance",
    asset: "USDC",
    kind: "spot",
    last: (bid + ask) / 2,
    bid,
    ask,
    spreadBps: ((ask - bid) / ((ask + bid) / 2)) * 10_000,
    topOfBookUsd: 2_000_000,
    high24h: 0,
    low24h: 0,
    change24hPct: 0,
    volume24hUsd: 0,
    ts: 1,
    ...over,
  };
}

function configWithCore(navUsd = 10_000) {
  const sleeves = defaultAllocations().map((a) =>
    a.sleeveId === "core" ? { ...a, allocatedUsd: 6_000, enabled: true } : a,
  );
  return { ...DEFAULT_CONFIG, navUsd, sleeves };
}

const tier = resolveTier(10_000, 999, "T5").current;

describe("scanStablePeg — L3", () => {
  it("takes a genuine discount through the edge gate", () => {
    // 1% below par is ~100bp gross against a few bp of cost.
    const opps = scanStablePeg({
      config: configWithCore(),
      quotes: [stableQuote()],
      tier,
      dataAgeSeconds: 1,
      halted: false,
    });
    expect(opps).toHaveLength(1);
    const o = opps[0];
    expect(o.strategy).toBe("L3");
    expect(o.route).toBe("Binance USDC repeg");
    expect(o.netBps).toBeGreaterThan(50);
    expect(o.wouldTake).toBe(true);
  });

  it("emits nothing for a healthy peg — silence, not noise", () => {
    const opps = scanStablePeg({
      config: configWithCore(),
      quotes: [stableQuote({ bid: 0.9999, ask: 1.0001 })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
    });
    expect(opps).toHaveLength(0);
  });

  it("refuses a dust deviation as uneconomic", () => {
    // 3bp below par cannot clear a 15bp edge floor after costs.
    const opps = scanStablePeg({
      config: configWithCore(),
      quotes: [stableQuote({ bid: 0.9996, ask: 0.9997 })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
    });
    expect(opps).toHaveLength(1);
    expect(opps[0].wouldTake).toBe(false);
    expect(opps[0].rejectionCode).toBe("net_edge_below_threshold");
  });

  it("never emits the short side of an above-par stable", () => {
    // Shorting a stable needs borrow; spot does not have it, so above par is
    // not an opportunity at all.
    const opps = scanStablePeg({
      config: configWithCore(),
      quotes: [stableQuote({ bid: 1.009, ask: 1.011 })],
      tier,
      dataAgeSeconds: 1,
      halted: false,
    });
    expect(opps).toHaveLength(0);
  });
});
