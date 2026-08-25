#!/usr/bin/env node
// Scanner behaviour test against a stubbed Polymarket. Verifies the serverless
// scanner finds the arbs it should, rejects the ones fees kill, and refuses to
// price an incomplete negRisk set (which would otherwise invent a phantom arb).
//
// The authoring sandbox cannot reach polymarket.com, so this is the contract.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------- fixtures
const BOOKS = {
  // binary event A: YES 0.45 + NO 0.50 @5% fee -> cost ~0.974 -> ~2.6% arb
  "tokA-yes": { asks: [{ price: "0.45", size: "5000" }], bids: [{ price: "0.44", size: "100" }] },
  "tokA-no": { asks: [{ price: "0.50", size: "5000" }], bids: [{ price: "0.49", size: "100" }] },
  // binary event B: 0.48 + 0.50 @5% -> 1.005 -> NOT an arb (spec §14.1)
  "tokB-yes": { asks: [{ price: "0.48", size: "5000" }], bids: [{ price: "0.47", size: "100" }] },
  "tokB-no": { asks: [{ price: "0.50", size: "5000" }], bids: [{ price: "0.49", size: "100" }] },
  // negRisk set of 3 @4%: 0.30/0.32/0.33 -> 0.97594 -> ~2.4% arb
  "tokC-1": { asks: [{ price: "0.30", size: "9000" }], bids: [] },
  "tokC-2": { asks: [{ price: "0.32", size: "9000" }], bids: [] },
  "tokC-3": { asks: [{ price: "0.33", size: "9000" }], bids: [] },
  // negRisk set where one leg has NO book — must be skipped entirely
  "tokD-1": { asks: [{ price: "0.20", size: "9000" }], bids: [] },
  "tokD-2": { asks: [], bids: [] },
  // nested brackets priced inconsistently: "by 2027" YES 0.60 sits ABOVE
  // "by 2028" YES 0.55, which containment forbids.
  "tokE1-yes": { asks: [{ price: "0.60", size: "4000" }], bids: [] },
  "tokE1-no": { asks: [{ price: "0.40", size: "4000" }], bids: [] },
  "tokE2-yes": { asks: [{ price: "0.55", size: "4000" }], bids: [] },
  "tokE2-no": { asks: [{ price: "0.45", size: "4000" }], bids: [] },
};

function market(id, tokens, opts = {}) {
  return {
    conditionId: id,
    question: opts.question ?? `Question ${id}?`,
    slug: id,
    outcomes: JSON.stringify(opts.outcomes ?? ["Yes", "No"]),
    clobTokenIds: JSON.stringify(tokens), // stringified, as Gamma really returns it
    closed: "false",
    negRisk: opts.negRisk ?? undefined, // often absent
    endDate: "2027-01-01T00:00:00Z",
  };
}

const EVENTS = [
  { id: "evA", title: "Event A", tags: '["sports"]', markets: [market("A", ["tokA-yes", "tokA-no"])] },
  { id: "evB", title: "Event B", tags: '["sports"]', markets: [market("B", ["tokB-yes", "tokB-no"])] },
  {
    id: "evC", title: "Who wins C?", tags: '["politics"]',
    markets: [
      market("C1", ["tokC-1"], { negRisk: true, outcomes: ["Yes"] }),
      market("C2", ["tokC-2"], { negRisk: true, outcomes: ["Yes"] }),
      market("C3", ["tokC-3"], { negRisk: true, outcomes: ["Yes"] }),
    ],
  },
  {
    id: "evE", title: "Nested brackets", tags: '["crypto"]',
    markets: [
      market("E1", ["tokE1-yes", "tokE1-no"], { question: "Will BTC hit 200k before 2027?" }),
      market("E2", ["tokE2-yes", "tokE2-no"], { question: "Will BTC hit 200k before 2028?" }),
    ],
  },
  {
    id: "evD", title: "Incomplete set D", tags: '["politics"]',
    markets: [
      market("D1", ["tokD-1"], { negRisk: true, outcomes: ["Yes"] }),
      market("D2", ["tokD-2"], { negRisk: true, outcomes: ["Yes"] }),
    ],
  },
];

let gammaCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("/events")) {
    gammaCalls++;
    const tag = new URL(u).searchParams.get("tag_slug");
    return json(EVENTS.filter((e) => e.tags.includes(tag ?? "")));
  }
  if (u.includes("/book")) {
    const tid = new URL(u).searchParams.get("token_id");
    const b = BOOKS[tid];
    return b ? json({ asset_id: tid, ...b }) : json({ asset_id: tid, asks: [], bids: [] });
  }
  if (u.includes("/fee-rate")) {
    const tid = new URL(u).searchParams.get("token_id");
    return json({ fee_rate_bps: tid.startsWith("tokC") || tid.startsWith("tokD") ? 400 : 500 });
  }
  if (u.includes("er-api.com")) return json({ rates: { ZAR: 18 } });
  throw new Error(`unstubbed fetch: ${u}`);
};

process.env.SCAN_MIN_MARGIN_PCT = "0.5";

const { scan } = await import(path.join(repo, "src/lib/events/scanner.ts"));
const result = await scan({ tags: ["sports", "politics", "crypto"], persist: false, maxMarkets: 50 });

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

test("gamma queried once per configured tag", () => assert.equal(gammaCalls, 3));

test("cheap binary pair detected as an arb", () => {
  const hit = result.opportunities.find((o) => o.event === "Question A?");
  assert.ok(hit, `expected an arb on event A, got ${JSON.stringify(result.opportunities)}`);
  assert.ok(Math.abs(hit.margin_pct - 2.512) < 0.01, `margin was ${hit.margin_pct}`);
});

test("fee-killed pair (§14.1 0.48+0.50 @5%) is NOT reported", () => {
  assert.ok(
    !result.opportunities.some((o) => o.event === "Question B?"),
    "0.48+0.50 at a 5% sports fee costs 1.005 — reporting it would be a false positive",
  );
});

test("complete negRisk set detected at ~2.4%", () => {
  const hit = result.opportunities.find((o) => o.event.includes("Who wins C"));
  assert.ok(hit, "expected the complete negRisk set to arb");
  assert.ok(Math.abs(hit.margin_pct - 2.41) < 0.15, `margin was ${hit.margin_pct}`);
});

test("incomplete negRisk set is refused, not priced", () => {
  assert.ok(
    !result.opportunities.some((o) => o.event.includes("Incomplete")),
    "a set missing a priced leg must never be treated as a full set",
  );
});

test("logical-consistency arb across nested brackets is found", () => {
  const hit = result.opportunities.find((o) => o.event.includes("⊂"));
  assert.ok(hit, `expected a nested-bracket arb, got ${JSON.stringify(result.opportunities)}`);
  // NO(by-2027) 0.40 + YES(by-2028) 0.55 at 5% fee -> ~2.6% floor
  assert.ok(hit.margin_pct > 1.5, `margin was ${hit.margin_pct}`);
});

test("scan reports what it covered", () => {
  assert.equal(result.scanned_events, 5);
  assert.equal(result.scanned_markets, 9, "1 + 1 + 3 + 2 + 2 markets across the five events");
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.fx.mid, 18);
  assert.ok(Math.abs(result.fx.buffered - 18 / 1.02) < 1e-9, "FX must carry the 2% buffer");
});

test("scores land in range and results are ranked", () => {
  for (const o of result.opportunities) {
    assert.ok(o.score >= 0 && o.score <= 100, `score ${o.score} out of range`);
  }
  const scores = result.opportunities.map((o) => o.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "results must be ranked");
});

console.log(
  `\n${passed} scanner checks passed.  (${result.opportunities.length} arbs from ${result.scanned_markets} markets in ${result.duration_ms}ms)`,
);
for (const o of result.opportunities) {
  console.log(`   ${o.margin_pct.toFixed(2)}%  score ${o.score}  ${o.event}`);
}
