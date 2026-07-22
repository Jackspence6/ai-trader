/**
 * Tests for crypto perp funding accrual.
 *
 * The property that matters: sign correctness. A short perp under positive
 * funding RECEIVES; a long PAYS; both flip when funding inverts. Getting any
 * of these backwards would book the strategy's core income stream in the
 * wrong direction and every downstream P&L number with it.
 */

import { describe, expect, it } from "vitest";
import { accruePerpFunding } from "./perpfunding";

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

const short = { asset: "BTC", qty: -2, sleeveId: "core", venue: "Binance", market: "perp" as const };
const long = { ...short, qty: 2 };

const apr = (rate: number) => () => rate;
const price = (p: number) => () => p;

describe("perp funding accrual", () => {
  it("pays a short under positive funding, scaled by time", () => {
    // 2 BTC at $100 = $200 notional, 10% APR for one year → $20.
    const out = accruePerpFunding([short], apr(0.1), price(100), YEAR_MS, 1);
    expect(out).toHaveLength(1);
    expect(out[0].amountUsd).toBeCloseTo(20);
    expect(out[0].sleeveId).toBe("core");
  });

  it("charges a long under positive funding", () => {
    const out = accruePerpFunding([long], apr(0.1), price(100), YEAR_MS, 1);
    expect(out[0].amountUsd).toBeCloseTo(-20);
  });

  it("flips both directions when funding inverts", () => {
    const [s] = accruePerpFunding([short], apr(-0.1), price(100), YEAR_MS, 1);
    const [l] = accruePerpFunding([long], apr(-0.1), price(100), YEAR_MS, 1);
    expect(s.amountUsd).toBeCloseTo(-20);
    expect(l.amountUsd).toBeCloseTo(20);
  });

  it("accrues pro rata over a partial interval", () => {
    const out = accruePerpFunding([short], apr(0.1), price(100), DAY_MS, 1);
    expect(out[0].amountUsd).toBeCloseTo(20 / 365, 6);
  });

  it("accrues nothing without a funding rate or a price", () => {
    expect(accruePerpFunding([short], () => undefined, price(100), DAY_MS, 1)).toHaveLength(0);
    expect(accruePerpFunding([short], apr(0.1), () => undefined, DAY_MS, 1)).toHaveLength(0);
  });

  it("ignores spot legs, FX positions, flat positions, and zero elapsed", () => {
    const spot = { ...short, market: "spot" as const };
    const fx = { ...short, venue: "fx" };
    const flat = { ...short, qty: 0 };
    expect(accruePerpFunding([spot, fx, flat], apr(0.1), price(100), DAY_MS, 1)).toHaveLength(0);
    expect(accruePerpFunding([short], apr(0.1), price(100), 0, 1)).toHaveLength(0);
  });
});
