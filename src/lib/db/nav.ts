/**
 * NAV history and tier-promotion accounting.
 *
 * The capital ladder promotes only when NAV has held above a threshold for 7
 * consecutive days (DESIGN.md §7). With no history that question is
 * unanswerable, which is why the ladder has been pinned at T0 regardless of the
 * NAV entered on the Control screen.
 *
 * Two deliberate choices in `daysHeldAbove`:
 *
 * 1. **Daily minimum, not daily close.** "Held above the threshold" means the
 *    whole day, so a dip below it mid-day breaks the streak. Using the close
 *    would let a NAV that spent the day underwater still count, which is
 *    exactly the lucky-spike case the hold period exists to filter out.
 *
 * 2. **Today is excluded from the streak.** A partial day is not a day held.
 *    Counting it would grant promotion a few hours early, which defeats the
 *    point of a confirmation period.
 */

import { query } from "./client";

export type NavPoint = { day: string; min: number; max: number; close: number };

/** Daily NAV summary, oldest first. */
export async function navByDay(limitDays = 90): Promise<NavPoint[]> {
  const rows = await query<{
    day: string;
    min: string;
    max: string;
    close: string;
  }>(
    `SELECT to_char(date_trunc('day', observed_at), 'YYYY-MM-DD') AS day,
            min(nav_usd)::text AS min,
            max(nav_usd)::text AS max,
            (array_agg(nav_usd ORDER BY observed_at DESC))[1]::text AS close
       FROM nav_history
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $1`,
    [limitDays],
  );

  return rows
    .map((r) => ({
      day: r.day,
      min: Number(r.min),
      max: Number(r.max),
      close: Number(r.close),
    }))
    .reverse();
}

/** The "YYYY-MM-DD" UTC day before `day`. */
function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Consecutive complete days NAV has stayed at or above `threshold`,
 * counting backwards from the day before `asOf`.
 *
 * Two properties matter for correctness, and both are about absence of data:
 *
 * - **The streak is anchored at yesterday.** History that stops three weeks
 *   ago is not evidence NAV is above the threshold *now*, so a gap between
 *   the last recorded day and yesterday means zero. The previous version
 *   counted from the last recorded day wherever it fell, which let stale
 *   history satisfy a promotion hold.
 * - **Days must be calendar-consecutive.** A day with no observations is a
 *   day we cannot claim NAV held above anything, so it breaks the streak
 *   rather than being skipped. Seven qualifying days spread over three weeks
 *   of patchy recording is not "held for 7 consecutive days".
 *
 * Returns 0 when there is no history — the conservative default, and the
 * correct one when we simply do not know. `asOf` exists so tests can pin the
 * anchor inside their seeded window instead of depending on the wall clock.
 */
export async function daysHeldAbove(
  threshold: number,
  asOf: Date = new Date(),
): Promise<number> {
  if (threshold <= 0) return 0;

  const days = await navByDay(400);
  if (days.length === 0) return 0;

  const today = asOf.toISOString().slice(0, 10);
  const complete = days.filter((d) => d.day < today);

  let streak = 0;
  let expected = dayBefore(today);
  for (let i = complete.length - 1; i >= 0; i--) {
    if (complete[i].day !== expected || complete[i].min < threshold) break;
    streak++;
    expected = dayBefore(expected);
  }
  return streak;
}

/**
 * Record a NAV observation directly.
 *
 * The recorder normally writes NAV to its JSONL stream and the importer loads
 * it, keeping one write path. This exists for the case where something needs
 * to record a NAV point without the recorder running.
 */
export async function recordNav(
  navUsd: number,
  source: string,
  observedAt: Date = new Date(),
): Promise<void> {
  await query(
    `INSERT INTO nav_history (observed_at, nav_usd, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (observed_at) DO NOTHING`,
    [observedAt, navUsd, source],
  );
}

export type LadderEvidence = {
  /** Consecutive complete days above the next tier's threshold. */
  daysHeld: number;
  /** How many days of NAV history exist at all. */
  daysOfHistory: number;
  available: boolean;
  /** Why the evidence is unavailable, when it is. */
  reason: string | null;
};

/**
 * Evidence for a promotion decision, degrading safely.
 *
 * When the database is down this returns `available: false` and zero days held,
 * so the ladder holds at its current tier rather than promoting on missing
 * information. Demotion is unaffected — it depends on current NAV alone and is
 * immediate by design.
 */
export async function ladderEvidence(threshold: number): Promise<LadderEvidence> {
  try {
    const [held, history] = await Promise.all([
      daysHeldAbove(threshold),
      navByDay(400),
    ]);
    return {
      daysHeld: held,
      daysOfHistory: history.length,
      available: true,
      reason: null,
    };
  } catch (e) {
    return {
      daysHeld: 0,
      daysOfHistory: 0,
      available: false,
      reason:
        e instanceof Error && /ECONNREFUSED|connect/i.test(e.message)
          ? "NAV history database is not running — the ladder holds at its current tier"
          : `NAV history unavailable — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * The effective capital tier, derived from NAV plus its history.
 *
 * Deliberately stateless. The obvious implementation stores "the tier we are
 * currently at" and mutates it on promotion, but that is a second source of
 * truth that can drift from the evidence — and a stored tier that says T2 when
 * the history no longer supports it is a silent loosening of every limit.
 *
 * Instead: the effective tier is the highest tier whose threshold NAV has both
 * cleared *now* and held for the required period. Demotion falls out for free
 * and is immediate, because a NAV below a tier's floor makes that tier
 * ineligible on the first condition regardless of history.
 */
export async function effectiveTier(
  navUsd: number,
  holdDays: number,
  tiers: { id: string; minNavUsd: number }[],
): Promise<{ tierId: string; daysHeld: number; blockedBy: string | null }> {
  // Candidates are tiers NAV currently clears, richest first.
  const eligible = [...tiers]
    .filter((t) => navUsd >= t.minNavUsd)
    .sort((a, b) => b.minNavUsd - a.minNavUsd);

  if (eligible.length === 0) {
    return { tierId: tiers[0]?.id ?? "T0", daysHeld: 0, blockedBy: null };
  }

  for (const tier of eligible) {
    // The lowest tier has a zero threshold and needs no hold period — there is
    // nothing to confirm about having no money.
    if (tier.minNavUsd <= 0) {
      return { tierId: tier.id, daysHeld: 0, blockedBy: null };
    }
    const held = await daysHeldAbove(tier.minNavUsd);
    if (held >= holdDays) {
      return { tierId: tier.id, daysHeld: held, blockedBy: null };
    }
  }

  // NAV clears a higher tier but the hold period is unmet. Sit at the base tier
  // and say which one is pending.
  const top = eligible[0];
  return {
    tierId: tiers[0]?.id ?? "T0",
    daysHeld: await daysHeldAbove(top.minNavUsd),
    blockedBy: top.id,
  };
}
