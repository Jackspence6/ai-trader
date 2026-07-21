/**
 * Tests for exchange venue adapters.
 *
 * Two groups matter more than the rest:
 *
 *   1. **The mainnet gate cannot be bypassed.** This is the only code in the
 *      system that can spend real money by accident. Three independent gates,
 *      and a test for each one failing alone.
 *
 *   2. **Quantisation rounds the safe way.** Quantity always down, price always
 *      toward the passive side. Rounding up a quantity breaches a limit the
 *      risk gate already approved against — a breach that happens after
 *      approval is one nobody sees.
 */

import { describe, expect, it } from "vitest";
import {
  checkMainnetGate,
  endpointFor,
  mainnetEnabledInEnvironment,
  testnetEndpoints,
  VENUE_ENDPOINTS,
} from "./environment";
import {
  precisionOf,
  quantisePrice,
  quantiseQty,
  validateOrder,
  type SymbolRules,
} from "./symbols";
import { ExchangeVenue } from "./exchange";
import type { OrderIntent } from "../types";

const RULES: SymbolRules = {
  symbol: "BTCUSDT",
  venue: "binance-testnet",
  market: "spot",
  status: "TRADING",
  tradable: true,
  tickSize: 0.01,
  stepSize: 0.00001,
  minQty: 0.00001,
  maxQty: 9000,
  minNotionalUsd: 5,
  pricePrecision: 2,
  qtyPrecision: 5,
  fetchedAt: Date.now(),
};

/* ------------------------------------------------------- environments */

describe("venue environments", () => {
  it("marks testnet endpoints as not live", () => {
    // "Live" means real money, not "reaches a real exchange". Testnet does
    // reach a real exchange and is deliberately not live.
    for (const e of testnetEndpoints()) {
      expect(e.environment).toBe("testnet");
    }
  });

  it("keeps Binance spot and futures testnets on separate hosts", () => {
    // They are entirely separate systems with separate keys and balances, and
    // a key from one fails on the other with an error that does not say so.
    const e = endpointFor("binance-testnet");
    expect(e.spotBase).not.toBe(e.perpBase);
  });

  it("points mainnet at the real hosts", () => {
    expect(endpointFor("binance-mainnet").spotBase).toBe("https://api.binance.com");
    expect(endpointFor("bybit-mainnet").spotBase).toBe("https://api.bybit.com");
  });

  it("throws on an unknown endpoint rather than defaulting to one", () => {
    // Defaulting here could silently pick mainnet.
    expect(() => endpointFor("nonsense")).toThrow(/Unknown venue endpoint/);
  });

  it("has a testnet counterpart for every mainnet venue", () => {
    const families = new Set(
      Object.values(VENUE_ENDPOINTS)
        .filter((e) => e.environment === "mainnet")
        .map((e) => e.family),
    );
    for (const f of families) {
      const hasTestnet = Object.values(VENUE_ENDPOINTS).some(
        (e) => e.family === f && e.environment === "testnet",
      );
      expect(hasTestnet, `${f} has no testnet`).toBe(true);
    }
  });
});

describe("the mainnet gate", () => {
  const mainnet = endpointFor("binance-mainnet");
  const testnet = endpointFor("binance-testnet");

  function withEnv(value: string | undefined, fn: () => void) {
    const prev = process.env.ALLOW_MAINNET_TRADING;
    if (value === undefined) delete process.env.ALLOW_MAINNET_TRADING;
    else process.env.ALLOW_MAINNET_TRADING = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.ALLOW_MAINNET_TRADING;
      else process.env.ALLOW_MAINNET_TRADING = prev;
    }
  }

  it("always allows testnet, with no ceremony", () => {
    withEnv(undefined, () => {
      expect(checkMainnetGate(testnet, "testnet", false).allowed).toBe(true);
    });
  });

  it("BLOCKS mainnet when the credential is a testnet key (gate 1)", () => {
    withEnv("true", () => {
      const g = checkMainnetGate(mainnet, "testnet", true);
      expect(g.allowed).toBe(false);
      if (!g.allowed) expect(g.failedGate).toBe(1);
    });
  });

  it("BLOCKS mainnet when ALLOW_MAINNET_TRADING is unset (gate 2)", () => {
    withEnv(undefined, () => {
      const g = checkMainnetGate(mainnet, "mainnet", true);
      expect(g.allowed).toBe(false);
      if (!g.allowed) expect(g.failedGate).toBe(2);
    });
  });

  it("BLOCKS mainnet on any value other than exactly 'true' (gate 2)", () => {
    // "1", "yes" and "TRUE" must not enable real-money trading. Loose truthiness
    // here is how an unrelated config change turns it on.
    for (const v of ["1", "yes", "TRUE", "on", ""]) {
      withEnv(v, () => {
        const g = checkMainnetGate(mainnet, "mainnet", true);
        expect(g.allowed, `value ${JSON.stringify(v)} should not enable mainnet`).toBe(
          false,
        );
      });
    }
  });

  it("BLOCKS mainnet when the call site did not confirm (gate 3)", () => {
    withEnv("true", () => {
      const g = checkMainnetGate(mainnet, "mainnet", false);
      expect(g.allowed).toBe(false);
      if (!g.allowed) expect(g.failedGate).toBe(3);
    });
  });

  it("allows mainnet only when ALL THREE gates agree", () => {
    withEnv("true", () => {
      expect(checkMainnetGate(mainnet, "mainnet", true).allowed).toBe(true);
    });
  });

  it("says WHICH gate failed, since each needs a different fix", () => {
    withEnv(undefined, () => {
      const g = checkMainnetGate(mainnet, "mainnet", true);
      if (!g.allowed) {
        expect(g.reason).toMatch(/ALLOW_MAINNET_TRADING/);
      }
    });
  });

  it("reports whether this process can trade real money at all", () => {
    withEnv(undefined, () => expect(mainnetEnabledInEnvironment()).toBe(false));
    withEnv("true", () => expect(mainnetEnabledInEnvironment()).toBe(true));
  });
});

/* ---------------------------------------------------------- precision */

describe("precision", () => {
  it("derives decimal places from a step size", () => {
    expect(precisionOf(0.01)).toBe(2);
    expect(precisionOf(0.00001)).toBe(5);
    expect(precisionOf(1)).toBe(0);
    expect(precisionOf(0.1)).toBe(1);
  });

  it("rounds quantity DOWN, never up", () => {
    // Rounding up can push a size past a limit the risk gate already approved
    // it against.
    expect(quantiseQty(0.123456789, RULES)).toBe(0.12345);
    expect(quantiseQty(1.999999, RULES)).toBe(1.99999);
  });

  it("produces no floating-point artefacts", () => {
    // Venues reject 0.30000000000000004.
    const q = quantiseQty(0.3, RULES);
    expect(String(q)).not.toMatch(/0{6,}\d/);
    expect(q).toBe(0.3);
  });

  it("rounds a BUY price down and a SELL price up", () => {
    // Toward the passive side, so quantisation never makes an order more
    // aggressive than intended.
    expect(quantisePrice(100.005, "buy", RULES)).toBe(100.0);
    expect(quantisePrice(100.005, "sell", RULES)).toBe(100.01);
  });

  it("leaves an already-aligned price untouched", () => {
    expect(quantisePrice(100.01, "buy", RULES)).toBe(100.01);
    expect(quantisePrice(100.01, "sell", RULES)).toBe(100.01);
  });
});

describe("order validation", () => {
  it("accepts a well-formed order and returns the quantised quantity", () => {
    const r = validateOrder(0.001234567, 60_000, RULES);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.qty).toBe(0.00123);
      expect(r.notionalUsd).toBeCloseTo(0.00123 * 60_000, 6);
    }
  });

  it("refuses a quantity that rounds to zero", () => {
    const r = validateOrder(0.000001, 60_000, RULES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/rounds to zero/);
  });

  it("refuses an order below the venue's minimum notional", () => {
    const r = validateOrder(0.00002, 60_000, RULES); // ~$1.20
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/below venue minimum/);
  });

  it("refuses a quantity above the venue maximum", () => {
    const r = validateOrder(100_000, 60_000, RULES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/above venue maximum/);
  });

  it("refuses a symbol that is not trading", () => {
    const r = validateOrder(1, 60_000, { ...RULES, tradable: false, status: "HALT" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not tradable/);
  });
});

/* ------------------------------------------------------------- adapter */

describe("ExchangeVenue", () => {
  const intent: OrderIntent = {
    id: "i1",
    ts: Date.now(),
    venue: "binance-testnet",
    asset: "BTC",
    market: "spot",
    side: "buy",
    qty: 0.001,
    type: "market",
    timeInForce: "IOC",
    sleeveId: "core",
    strategy: "L1",
    rationale: "test",
  };

  it("reports testnet as NOT live", () => {
    const v = new ExchangeVenue({
      endpoint: endpointFor("binance-testnet"),
      apiKey: "k",
      apiSecret: "s",
      credentialEnvironment: "testnet",
    });
    expect(v.isLive).toBe(false);
  });

  it("reports mainnet as live", () => {
    const v = new ExchangeVenue({
      endpoint: endpointFor("binance-mainnet"),
      apiKey: "k",
      apiSecret: "s",
      credentialEnvironment: "mainnet",
    });
    expect(v.isLive).toBe(true);
  });

  it("refuses to submit to mainnet without confirmation, before any network call", async () => {
    const prev = process.env.ALLOW_MAINNET_TRADING;
    delete process.env.ALLOW_MAINNET_TRADING;
    try {
      const v = new ExchangeVenue({
        endpoint: endpointFor("binance-mainnet"),
        apiKey: "k",
        apiSecret: "s",
        credentialEnvironment: "mainnet",
      });
      const r = await v.submit({ ...intent, venue: "binance-mainnet" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/mainnet gate/);
    } finally {
      if (prev !== undefined) process.env.ALLOW_MAINNET_TRADING = prev;
    }
  });

  it("checks the gate per order, not once at construction", async () => {
    // A venue object created while mainnet was permitted must not keep that
    // permission after the environment changes.
    process.env.ALLOW_MAINNET_TRADING = "true";
    const v = new ExchangeVenue({
      endpoint: endpointFor("binance-mainnet"),
      apiKey: "k",
      apiSecret: "s",
      credentialEnvironment: "mainnet",
      confirmMainnet: true,
    });
    delete process.env.ALLOW_MAINNET_TRADING;

    const r = await v.submit({ ...intent, venue: "binance-mainnet" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/gate 2\/3/);
  });

  it("returns no open orders when the gate blocks, rather than throwing", async () => {
    const prev = process.env.ALLOW_MAINNET_TRADING;
    delete process.env.ALLOW_MAINNET_TRADING;
    try {
      const v = new ExchangeVenue({
        endpoint: endpointFor("binance-mainnet"),
        apiKey: "k",
        apiSecret: "s",
        credentialEnvironment: "mainnet",
      });
      expect(await v.openOrders()).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.ALLOW_MAINNET_TRADING = prev;
    }
  });
});
