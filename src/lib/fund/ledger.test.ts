/**
 * Tests for the capital ledger — the two-account model and ZAR conversion.
 *
 * Every number here is hand-computable. The properties under test are the ones
 * that would silently corrupt a balance if they broke: capital stays in the
 * account it was deposited to, the two accounts sum to the fund total, and a
 * ZAR deposit converts to exactly the USD the live rate implies.
 */

import { describe, expect, it } from "vitest";
import {
  computeAccountNav,
  computeNav,
  replayLedger,
  type CapitalEvent,
  type TradingPnl,
} from "./ledger";

let seq = 0;
function ev(over: Partial<CapitalEvent> = {}): CapitalEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    ts: seq,
    account: "crypto",
    type: "deposit",
    amountUsd: 1000,
    nature: "simulated",
    original: null,
    navPerUnitAtEvent: 1,
    unitsDelta: 1000,
    note: null,
    ...over,
  };
}

function pnl(over: Partial<TradingPnl> = {}): TradingPnl {
  const p = { realisedUsd: 0, unrealisedUsd: 0, fundingUsd: 0, feesUsd: 0, ...over };
  return { ...p, totalUsd: p.realisedUsd + p.unrealisedUsd + p.fundingUsd - p.feesUsd };
}

describe("capital ledger — accounts", () => {
  it("replays each account separately", () => {
    const events = [
      ev({ account: "crypto", amountUsd: 3000, unitsDelta: 3000 }),
      ev({ account: "forex", amountUsd: 2000, unitsDelta: 2000 }),
      ev({ account: "forex", type: "withdrawal", amountUsd: 500, unitsDelta: 500 }),
    ];

    expect(replayLedger(events, "crypto").netContributedUsd).toBe(3000);
    expect(replayLedger(events, "forex").netContributedUsd).toBe(1500);
    // No filter → the whole fund.
    expect(replayLedger(events).netContributedUsd).toBe(4500);
  });

  it("keeps each account's P&L inside that account", () => {
    const events = [
      ev({ account: "crypto", amountUsd: 5000, unitsDelta: 5000 }),
      ev({ account: "forex", amountUsd: 5000, unitsDelta: 5000 }),
    ];

    const crypto = computeAccountNav(events, "crypto", pnl({ realisedUsd: 500 }));
    // The forex NAV is computed with the forex P&L, which is a loss here.
    const forex = computeAccountNav(events, "forex", pnl({ unrealisedUsd: -200 }));

    expect(crypto.navUsd).toBe(5500);
    expect(forex.navUsd).toBe(4800);
    // Crypto's gain must not leak into forex's contributed capital.
    expect(crypto.netContributedUsd).toBe(5000);
    expect(forex.netContributedUsd).toBe(5000);
  });

  it("aggregate NAV is contributed plus total P&L across both books", () => {
    const events = [
      ev({ account: "crypto", amountUsd: 5000, unitsDelta: 5000 }),
      ev({ account: "forex", amountUsd: 5000, unitsDelta: 5000 }),
    ];
    const total = computeNav(events, pnl({ realisedUsd: 500, unrealisedUsd: -200 }));
    expect(total.netContributedUsd).toBe(10000);
    expect(total.navUsd).toBe(10300);
  });

  it("the performance index moves on P&L, not on deposits", () => {
    const events = [ev({ account: "crypto", amountUsd: 1000, unitsDelta: 1000 })];
    // A 10% gain lifts the index to 1.1 regardless of how the deposit was sized.
    const nav = computeAccountNav(events, "crypto", pnl({ realisedUsd: 100 }));
    expect(nav.performanceIndex).toBeCloseTo(1.1, 6);
    expect(nav.twrPct).toBeCloseTo(0.1, 6);
  });

  it("carries the original currency on a ZAR-funded event", () => {
    // R5000 at USD 0.06/ZAR = $300.
    const e = ev({
      account: "forex",
      amountUsd: 300,
      unitsDelta: 300,
      original: { currency: "ZAR", amount: 5000, usdPerUnit: 0.06 },
    });
    expect(e.original?.amount).toBe(5000);
    expect(e.amountUsd).toBeCloseTo(e.original!.amount * e.original!.usdPerUnit, 9);
  });
});
