/**
 * The execution seam.
 *
 * These tests exist because the loop used to construct its venue inline, which
 * meant "we are on paper" was true by accident rather than by decision. Each
 * case below is a way to end up trading real money that must not work.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveVenue } from "./resolve";

const CRED = {
  endpointId: "binance-mainnet",
  apiKey: "k",
  apiSecret: "s",
  environment: "mainnet" as const,
};

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.MERIDIAN_EXECUTION;
  delete process.env.ALLOW_MAINNET_TRADING;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("resolveVenue", () => {
  it("is paper when nothing is set", () => {
    const r = resolveVenue();
    expect(r.mode).toBe("paper");
    expect(r.venue.isLive).toBe(false);
  });

  it("is paper for an unrecognised execution mode", () => {
    process.env.MERIDIAN_EXECUTION = "yes";
    expect(resolveVenue().mode).toBe("paper");
  });

  it("stays on paper when live is asked for with no credential", () => {
    process.env.MERIDIAN_EXECUTION = "live";
    process.env.ALLOW_MAINNET_TRADING = "true";
    const r = resolveVenue();
    expect(r.mode).toBe("paper");
    expect(r.reason).toMatch(/no exchange credential/i);
  });

  it("stays on paper when live is asked for without the environment flag", () => {
    // Two independent switches, and neither implies the other. This is the one
    // most likely to be hit in practice: the operator sets the mode, forgets
    // the flag, and must not be quietly upgraded to real money.
    process.env.MERIDIAN_EXECUTION = "live";
    const r = resolveVenue({ credential: CRED });
    expect(r.mode).toBe("paper");
    expect(r.reason).toMatch(/ALLOW_MAINNET_TRADING/);
  });

  it("refuses a credential whose environment does not match the endpoint", () => {
    process.env.MERIDIAN_EXECUTION = "live";
    process.env.ALLOW_MAINNET_TRADING = "true";
    const r = resolveVenue({
      credential: { ...CRED, environment: "testnet" },
    });
    expect(r.mode).toBe("paper");
    expect(r.reason).toMatch(/mismatch/i);
  });

  it("refuses to call a testnet endpoint 'live'", () => {
    process.env.MERIDIAN_EXECUTION = "live";
    process.env.ALLOW_MAINNET_TRADING = "true";
    const r = resolveVenue({
      credential: {
        endpointId: "binance-testnet",
        apiKey: "k",
        apiSecret: "s",
        environment: "testnet",
      },
    });
    expect(r.mode).toBe("paper");
    expect(r.reason).toMatch(/testnet endpoint/i);
  });

  it("always explains itself", () => {
    // Every path returns a reason, so an operator asking "why is this on paper?"
    // reads an answer rather than inferring one.
    expect(resolveVenue().reason.length).toBeGreaterThan(20);
  });
});
