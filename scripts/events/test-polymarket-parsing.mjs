#!/usr/bin/env node
// Fixture tests for the serverless Polymarket parsers. The authoring sandbox's
// egress blocks polymarket.com, so these fixtures — built from the payload shapes
// the spec §3.4 calls out as sharp edges — are what stands between a parser bug and
// a phantom arb in production. Run: npm run test:parsing

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pm = await import(path.join(repo, "src/lib/events/polymarket.ts"));
const arb = await import(path.join(repo, "src/lib/events/arb.ts"));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// --- Gamma: array fields arrive as JSON-encoded STRINGS ---------------------
test("gamma parses stringified arrays and missing negRisk", () => {
  const m = pm.parseGammaMarket(
    {
      conditionId: "0xc0ffee",
      question: "Will the Lakers beat the Celtics?",
      slug: "lakers-celtics",
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.485", "0.515"]',
      clobTokenIds: '["111", "222"]',
      closed: "false",
      // negRisk deliberately absent
    },
    { id: "9", title: "Lakers vs. Celtics", tags: '["nba"]' },
  );
  assert.ok(m);
  assert.deepEqual(m.outcomes, ["Yes", "No"]);
  assert.deepEqual(m.tokenIds, ["111", "222"]);
  assert.equal(m.negRisk, false, "absent negRisk must default false, never throw");
  assert.equal(m.category, "nba");
  assert.equal(m.eventId, "9");
});

test("gamma rejects markets with no tokens", () => {
  assert.equal(pm.parseGammaMarket({ conditionId: "0x1", clobTokenIds: "[]" }), null);
  assert.equal(pm.parseGammaMarket({ clobTokenIds: '["1"]' }), null);
});

test("gamma reads negRisk from the event when the market omits it", () => {
  const m = pm.parseGammaMarket(
    { conditionId: "0x2", clobTokenIds: '["a"]', outcomes: '["Yes"]' },
    { id: "7", negRisk: true },
  );
  assert.equal(m.negRisk, true);
});

// --- CLOB books: ordering must never be trusted -----------------------------
test("book re-sorts both sides and reads best prices", () => {
  const b = pm.parseBook({
    asset_id: "111",
    asks: [{ price: "0.55", size: "10" }, { price: "0.52", size: "5" }],
    bids: [{ price: "0.40", size: "3" }, { price: "0.48", size: "7" }],
  });
  assert.equal(pm.bestAsk(b), 0.52);
  assert.equal(b.bids[0].price, 0.48);
  assert.deepEqual(b.asks.map((l) => l.price), [0.52, 0.55]);
});

test("crossed book rejected as side inversion", () => {
  const b = pm.parseBook({
    asset_id: "111",
    asks: [{ price: "0.40", size: "1" }],
    bids: [{ price: "0.60", size: "1" }],
  });
  assert.equal(b, null, "a bid above the ask means corrupt data — must not trade on it");
});

test("book accepts tuple levels and drops garbage", () => {
  const b = pm.parseBook({ token_id: "t", asks: [["0.5", "10"], ["bad", "x"], ["0.51"]], bids: [] });
  assert.equal(b.asks.length, 1);
  assert.equal(b.asks[0].price, 0.5);
});

test("empty book yields no best ask", () => {
  assert.equal(pm.bestAsk(pm.parseBook({ asset_id: "x", asks: [], bids: [] })), null);
  assert.equal(pm.bestAsk(null), null);
});

// --- fee rate spellings -----------------------------------------------------
test("fee-rate accepts bps and fraction spellings", () => {
  assert.equal(pm.parseFeeRate({ fee_rate_bps: 500 }, 0.03), 0.05);
  assert.equal(pm.parseFeeRate({ feeRateBps: "400" }, 0.03), 0.04);
  assert.equal(pm.parseFeeRate({ fee_rate: 0.07 }, 0.03), 0.07);
  assert.equal(pm.parseFeeRate(700, 0.03), 0.07);
  assert.equal(pm.parseFeeRate(0.05, 0.03), 0.05);
  assert.equal(pm.parseFeeRate({ unexpected: true }, 0.03), 0.03);
  assert.equal(pm.parseFeeRate(null, 0.03), 0.03);
  assert.equal(pm.parseFeeRate("garbage", 0.03), 0.03);
});

// --- the economics the scanner acts on -------------------------------------
test("§14.1 YES+NO at 0.48/0.50 with 5% sports fee is NOT an arb", () => {
  const cost = arb.binaryPairCost(0.48, 0.5, 0.05);
  assert.ok(cost > 1, `cost ${cost} must exceed 1 — fees kill this one`);
});

test("a genuinely cheap pair IS an arb after fees", () => {
  const cost = arb.binaryPairCost(0.45, 0.5, 0.05);
  assert.ok(cost < 1, `cost ${cost} should be under 1`);
});

test("negRisk complete set at 0.30/0.32/0.33 @4% is a ~2.4% arb", () => {
  const cost = arb.negRiskFullSetCost([0.3, 0.32, 0.33], 0.04);
  assert.ok(Math.abs((1 - cost) * 100 - 2.41) < 0.05, `margin was ${(1 - cost) * 100}`);
});

test("depth capacity respects the slippage bound", () => {
  const cap = arb.depthCapacityUsd(
    [{ price: 0.5, size: 1000 }, { price: 0.52, size: 1000 }], 0.5, 0.05, 50);
  assert.ok(Math.abs(cap - 512.5) < 1e-9, `cap was ${cap}`);
});

console.log(`\n${passed} parsing/economics checks passed.`);
