/**
 * Trading-loop health, derived from the pass log.
 *
 * The loop has no PID heartbeat the way the recorder does — it may be the
 * local script, the deployment cron, or nothing. What it does have is a
 * durable record per pass, so liveness is *derived*: how long since the last
 * pass, measured against the loop's own observed cadence rather than a
 * hard-coded interval. Two silent failure modes this exists to surface:
 *
 *   - **The loop stopped** (or is running code so old it writes nothing) —
 *     visible as last-pass age far beyond the observed cadence.
 *   - **The loop is running but blind** — passes score zero opportunities
 *     because every venue fetch fails. Each individual pass looks fine; the
 *     streak is the signal.
 */

import type { TradePassRecord } from "./pass";

export type LoopHealth = {
  /** No pass has ever been recorded. */
  everRan: boolean;
  lastPassTs: number | null;
  lastPassAgeSeconds: number | null;
  /** Median seconds between recent passes — the loop's own cadence. */
  medianIntervalSeconds: number | null;
  state: "running" | "late" | "stopped" | "never";
  /** Consecutive most-recent passes that scored zero opportunities. */
  zeroScoredStreak: number;
  /** The skip reason of the latest pass, when it was skipped. */
  lastSkipped: string | null;
  /** Totals over the records provided (the caller bounds the window). */
  passes: number;
  executed: number;
  closed: number;
  scored: number;
};

/** Late past 2× cadence, stopped past 6× — generous enough for jitter. */
const LATE_FACTOR = 2;
const STOPPED_FACTOR = 6;

export function loopHealth(records: TradePassRecord[], now: number): LoopHealth {
  if (records.length === 0) {
    return {
      everRan: false,
      lastPassTs: null,
      lastPassAgeSeconds: null,
      medianIntervalSeconds: null,
      state: "never",
      zeroScoredStreak: 0,
      lastSkipped: null,
      passes: 0,
      executed: 0,
      closed: 0,
      scored: 0,
    };
  }

  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  const last = sorted[sorted.length - 1];
  const ageSeconds = Math.max(0, (now - last.ts) / 1000);

  const gaps = sorted
    .slice(1)
    .map((r, i) => (r.ts - sorted[i].ts) / 1000)
    .filter((g) => g > 0)
    .sort((a, b) => a - b);
  const medianIntervalSeconds =
    gaps.length === 0 ? null : gaps[Math.floor(gaps.length / 2)];

  // With one pass and no cadence to judge against, being generous is the
  // honest option: report running and let age speak for itself.
  const state: LoopHealth["state"] =
    medianIntervalSeconds === null
      ? "running"
      : ageSeconds > medianIntervalSeconds * STOPPED_FACTOR
        ? "stopped"
        : ageSeconds > medianIntervalSeconds * LATE_FACTOR
          ? "late"
          : "running";

  let zeroScoredStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].scored === 0) zeroScoredStreak++;
    else break;
  }

  return {
    everRan: true,
    lastPassTs: last.ts,
    lastPassAgeSeconds: ageSeconds,
    medianIntervalSeconds,
    state,
    zeroScoredStreak,
    lastSkipped: last.skipped ?? null,
    passes: sorted.length,
    executed: sorted.reduce((a, r) => a + r.executed, 0),
    closed: sorted.reduce((a, r) => a + (r.closed ?? 0), 0),
    scored: sorted.reduce((a, r) => a + r.scored, 0),
  };
}
