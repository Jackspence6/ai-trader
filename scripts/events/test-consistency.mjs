#!/usr/bin/env node
// Logical-consistency detector tests (spec §5 type 3).
//
// The math is trivial; the PAIRING is where money is lost. These tests are mostly
// about what the matcher must REFUSE to pair, because a false pairing invents an
// arbitrage that does not exist.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const c = await import(path.join(repo, "src/lib/events/consistency.ts"));

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

function mkt(id, question, tokens = [`${id}-yes`, `${id}-no`], negRisk = false) {
  return {
    conditionId: id, question, slug: id, outcomes: ["Yes", "No"],
    tokenIds: tokens, negRisk, closed: false, category: "crypto",
    eventId: "ev1", eventTitle: "Event", endDate: null,
  };
}

// ------------------------------------------------------------- extraction
test("extracts month deadlines", () => {
  const t = c.extractThreshold("Will BTC hit 200k by June 30, 2027?");
  assert.equal(t.kind, "date");
  assert.equal(new Date(t.value).getUTCFullYear(), 2027);
  assert.equal(new Date(t.value).getUTCMonth(), 5);
});

test("extracts bare-year deadlines", () => {
  const t = c.extractThreshold("Will BTC hit 200k before 2027?");
  assert.equal(t.kind, "date");
  assert.equal(new Date(t.value).getUTCFullYear(), 2027);
});

test("extracts numeric thresholds with scale suffixes", () => {
  assert.equal(c.extractThreshold("Will BTC go above $150k?").value, 150_000);
  assert.equal(c.extractThreshold("Will revenue reach 2 million?").value, 2_000_000);
  assert.equal(c.extractThreshold("Will it exceed nothing at all?"), null);
});

// ---------------------------------------------------------------- pairing
test("pairs nested date brackets with the earlier one as inner", () => {
  const pairs = c.findNestedPairs([
    mkt("a", "Will BTC hit 200k before 2027?"),
    mkt("b", "Will BTC hit 200k before 2028?"),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].inner.conditionId, "a", "the earlier deadline is the harder claim");
  assert.equal(pairs[0].outer.conditionId, "b");
  assert.equal(pairs[0].basis, "date");
});

test("pairs numeric thresholds with the HIGHER bar as inner", () => {
  const pairs = c.findNestedPairs([
    mkt("low", "Will BTC go above $100k?"),
    mkt("high", "Will BTC go above $150k?"),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].inner.conditionId, "high", "a higher bar is the harder claim");
  assert.equal(pairs[0].outer.conditionId, "low");
});

test("REFUSES to pair different subjects", () => {
  const pairs = c.findNestedPairs([
    mkt("a", "Will BTC hit 200k before 2027?"),
    mkt("b", "Will ETH hit 200k before 2028?"),
  ]);
  assert.equal(pairs.length, 0, "different assets are not nested — pairing them invents an arb");
});

test("REFUSES to pair when only one has a parseable threshold", () => {
  const pairs = c.findNestedPairs([
    mkt("a", "Will BTC hit 200k before 2027?"),
    mkt("b", "Will BTC hit 200k this cycle?"),
  ]);
  assert.equal(pairs.length, 0);
});

test("REFUSES identical thresholds (no containment)", () => {
  const pairs = c.findNestedPairs([
    mkt("a", "Will BTC hit 200k before 2027?"),
    mkt("b", "Will BTC hit 200k before 2027?"),
  ]);
  assert.equal(pairs.length, 0);
});

test("REFUSES negRisk members and non-binary markets", () => {
  assert.equal(c.findNestedPairs([
    mkt("a", "Will BTC hit 200k before 2027?", ["a-y", "a-n"], true),
    mkt("b", "Will BTC hit 200k before 2028?", ["b-y", "b-n"], true),
  ]).length, 0, "negRisk sets have their own exact relation");

  assert.equal(c.findNestedPairs([
    mkt("a", "Will BTC hit 200k before 2027?", ["only-one-token"]),
    mkt("b", "Will BTC hit 200k before 2028?"),
  ]).length, 0);
});

test("chains three brackets into all nested pairs", () => {
  const pairs = c.findNestedPairs([
    mkt("a", "Will X happen before 2026?"),
    mkt("b", "Will X happen before 2027?"),
    mkt("c", "Will X happen before 2028?"),
  ]);
  assert.equal(pairs.length, 3, "a<b, a<c, b<c");
});

// ---------------------------------------------------------------- pricing
function priced(innerNo, outerYes, fee = 0.04) {
  const pairs = c.findNestedPairs([
    mkt("inner", "Will X happen before 2027?"),
    mkt("outer", "Will X happen before 2028?"),
  ]);
  const books = new Map([
    ["inner-no", { tokenId: "inner-no", bids: [], asks: [{ price: innerNo, size: 5000 }] }],
    ["outer-yes", { tokenId: "outer-yes", bids: [], asks: [{ price: outerYes, size: 5000 }] }],
  ]);
  const fees = new Map([["inner-no", fee], ["outer-yes", fee]]);
  return c.detectConsistencyArb(pairs[0], books, fees, 0.5);
}

test("prices a real inconsistency as an arb", () => {
  // inner priced at 0.60 YES (=0.40 NO) while outer YES is only 0.55 —
  // "by 2027" is being priced ABOVE "by 2028", which is impossible.
  const arb = priced(0.40, 0.55);
  assert.ok(arb, "expected an arb");
  assert.ok(arb.marginPct > 3, `margin was ${arb.marginPct}`);
  assert.ok(arb.costPerSet < 1);
});

test("a consistent pair is NOT an arb", () => {
  // inner YES 0.30 (NO 0.70), outer YES 0.55 -> cost > 1, correctly rejected
  assert.equal(priced(0.70, 0.55), null);
});

test("fees can kill a thin inconsistency", () => {
  const cheapFee = priced(0.49, 0.50, 0.0);   // geopolitics: no fee
  const sportsFee = priced(0.49, 0.50, 0.05);
  assert.ok(cheapFee, "with no fee this is a 1% edge");
  assert.equal(sportsFee, null, "at a 5% fee the same prices are not an arb");
});

test("missing book or fee yields no arb rather than a guess", () => {
  const pairs = c.findNestedPairs([
    mkt("inner", "Will X happen before 2027?"),
    mkt("outer", "Will X happen before 2028?"),
  ]);
  const emptyBooks = new Map([["inner-no", { tokenId: "inner-no", bids: [], asks: [] }]]);
  assert.equal(c.detectConsistencyArb(pairs[0], emptyBooks, new Map(), 0.5), null);
});

console.log(`\n${passed} consistency checks passed.`);
