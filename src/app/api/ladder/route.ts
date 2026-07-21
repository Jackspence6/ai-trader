/**
 * Capital-tier state, derived from NAV plus its recorded history.
 *
 * The ladder needs to know whether NAV has *held* above a threshold, not just
 * whether it clears it now. That question needs history, which is why this
 * route is the one place the dashboard reads the database.
 *
 * It degrades rather than failing: with the database down there is no history,
 * so the tier holds at T0 and the response says why. Holding is the safe
 * direction — promotion loosens limits, and loosening on missing evidence is
 * exactly the failure the hold period exists to prevent.
 */

import { PROMOTION_HOLD_DAYS, TIERS, tierForNav } from "@/lib/calc/tiers";
import { getNavUsd } from "@/lib/fund/nav";
import { effectiveTier, ladderEvidence, navByDay } from "@/lib/db/nav";

export async function GET() {
  const nav = await getNavUsd();
  const implied = tierForNav(nav);

  try {
    const [resolved, evidence, history] = await Promise.all([
      effectiveTier(nav, PROMOTION_HOLD_DAYS, TIERS),
      ladderEvidence(implied.minNavUsd),
      navByDay(90),
    ]);

    const current = TIERS.find((t) => t.id === resolved.tierId) ?? TIERS[0];

    return Response.json(
      {
        navUsd: nav,
        currentTierId: current.id,
        impliedTierId: implied.id,
        daysHeld: resolved.daysHeld,
        holdDaysRequired: PROMOTION_HOLD_DAYS,
        awaitingPromotion: resolved.blockedBy !== null,
        blockedBy: resolved.blockedBy,
        historyAvailable: evidence.available,
        daysOfHistory: evidence.daysOfHistory,
        reason: evidence.reason,
        navHistory: history,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      {
        navUsd: nav,
        currentTierId: TIERS[0].id,
        impliedTierId: implied.id,
        daysHeld: 0,
        holdDaysRequired: PROMOTION_HOLD_DAYS,
        awaitingPromotion: implied.id !== TIERS[0].id,
        blockedBy: implied.id !== TIERS[0].id ? implied.id : null,
        historyAvailable: false,
        daysOfHistory: 0,
        reason:
          "NAV history unavailable — the ladder holds at T0 rather than promoting on missing evidence" +
          (e instanceof Error ? ` (${e.message})` : ""),
        navHistory: [],
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
}
