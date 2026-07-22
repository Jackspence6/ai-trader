/**
 * Tests for derived loop health.
 *
 * The judgments that matter: staleness is measured against the loop's OWN
 * cadence (a 5-minute loop and an hourly cron have different "late"), and a
 * zero-scored streak is read from the newest passes only — one blind pass in
 * old history is noise, five in a row right now is an outage.
 */

import { describe, expect, it } from "vitest";
import type { TradePassRecord } from "./pass";
import { loopHealth } from "./health";

const MIN = 60_000;

function rec(over: Partial<TradePassRecord> = {}): TradePassRecord {
  return {
    ts: 0,
    navBefore: 10_000,
    navAfter: 10_000,
    pnl: { realisedUsd: 0, unrealisedUsd: 0, fundingUsd: 0, feesUsd: 0, totalUsd: 0 },
    scored: 20,
    executed: 0,
    rejected: 20,
    closed: 0,
    exits: {},
    riskBreaches: [],
    openPositions: 2,
    accuracy: [],
    rejections: {},
    executions: [],
    skipped: null,
    ...over,
  };
}

/** Passes every 5 minutes, newest at `endTs`. */
function cadence(n: number, endTs: number, over: (i: number) => Partial<TradePassRecord> = () => ({})) {
  return Array.from({ length: n }, (_, i) =>
    rec({ ts: endTs - (n - 1 - i) * 5 * MIN, ...over(i) }),
  );
}

describe("loopHealth", () => {
  it("reports never when nothing has run", () => {
    const h = loopHealth([], 1000);
    expect(h.state).toBe("never");
    expect(h.everRan).toBe(false);
  });

  it("reports running just after a pass, with the observed cadence", () => {
    const now = 100 * MIN;
    const h = loopHealth(cadence(10, now - MIN), now);
    expect(h.state).toBe("running");
    expect(h.medianIntervalSeconds).toBe(300);
    expect(h.lastPassAgeSeconds).toBe(60);
  });

  it("reports late past twice its own cadence, stopped past six times", () => {
    const now = 1000 * MIN;
    expect(loopHealth(cadence(10, now - 11 * MIN), now).state).toBe("late");
    expect(loopHealth(cadence(10, now - 31 * MIN), now).state).toBe("stopped");
  });

  it("counts the zero-scored streak from the newest passes only", () => {
    const now = 100 * MIN;
    const records = cadence(10, now - MIN, (i) =>
      // Older blind pass at i=2, then the last three blind again.
      i === 2 || i >= 7 ? { scored: 0 } : {},
    );
    const h = loopHealth(records, now);
    expect(h.zeroScoredStreak).toBe(3);
  });

  it("sums window totals and surfaces the last skip reason", () => {
    const now = 100 * MIN;
    const records = cadence(3, now - MIN, (i) => ({
      executed: 1,
      closed: i === 2 ? 1 : 0,
      skipped: i === 2 ? "halted — test" : null,
    }));
    const h = loopHealth(records, now);
    expect(h.executed).toBe(3);
    expect(h.closed).toBe(1);
    expect(h.lastSkipped).toBe("halted — test");
  });

  it("tolerates unsorted input", () => {
    const now = 100 * MIN;
    const records = cadence(5, now - MIN).reverse();
    const h = loopHealth(records, now);
    expect(h.state).toBe("running");
    expect(h.medianIntervalSeconds).toBe(300);
  });
});
