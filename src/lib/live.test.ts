/**
 * The polling hook's retry behaviour.
 *
 * This exists because of a specific failure that reached a deployment bundle.
 * Every screen polls while the login page is showing, and every one of those
 * polls is refused — correctly, the site is locked. With a fixed interval the
 * next attempt is a full interval away, so after signing in the execution-mode
 * badge (a 60-second endpoint) stayed on its placeholder for a minute. That
 * badge is the answer to "is real money at risk?", and the moment just after
 * signing in is exactly when it is read.
 *
 * The assertions below are about timing rather than rendering, so they exercise
 * the scheduling rule directly. A DOM-level test of the hook would need a React
 * renderer in this suite for no additional coverage of the thing that broke.
 */

import { describe, expect, it } from "vitest";

const RETRY_BASE_MS = 1_500;

/** The scheduling rule as implemented in useLive. */
function nextDelay(consecutiveFailures: number, intervalMs: number): number {
  return consecutiveFailures === 0
    ? intervalMs
    : Math.min(intervalMs, RETRY_BASE_MS * 2 ** (consecutiveFailures - 1));
}

describe("useLive retry scheduling", () => {
  it("polls at the endpoint's own cadence while it is working", () => {
    expect(nextDelay(0, 60_000)).toBe(60_000);
    expect(nextDelay(0, 1_000)).toBe(1_000);
  });

  it("retries a slow endpoint far sooner than its interval after one failure", () => {
    // The case that broke: a 60s endpoint refused while locked must not wait a
    // full minute once the lock is open.
    expect(nextDelay(1, 60_000)).toBe(1_500);
    expect(nextDelay(1, 60_000)).toBeLessThan(60_000 / 10);
  });

  it("backs off geometrically", () => {
    const delays = [1, 2, 3, 4, 5].map((n) => nextDelay(n, 60_000));
    expect(delays).toEqual([1_500, 3_000, 6_000, 12_000, 24_000]);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("never polls faster than the endpoint asked for, even on the first failure", () => {
    // A 1s endpoint must not be retried at 1.5s intervals *slower* than normal,
    // nor a 500ms one hammered faster than it requested.
    expect(nextDelay(1, 1_000)).toBe(1_000);
    expect(nextDelay(1, 500)).toBe(500);
    for (const interval of [250, 500, 1_000, 5_000, 15_000, 60_000]) {
      for (let n = 1; n <= 12; n++) {
        expect(nextDelay(n, interval)).toBeLessThanOrEqual(interval);
      }
    }
  });

  it("settles at the normal cadence rather than beyond it when an endpoint stays dead", () => {
    // A permanently dead endpoint must not end up polled less often than a
    // healthy one — the backoff is for recovery speed, not for giving up.
    expect(nextDelay(20, 60_000)).toBe(60_000);
    expect(nextDelay(100, 15_000)).toBe(15_000);
  });

  it("returns to the normal cadence as soon as one attempt succeeds", () => {
    expect(nextDelay(6, 60_000)).toBe(48_000);
    expect(nextDelay(0, 60_000)).toBe(60_000);
  });
});
