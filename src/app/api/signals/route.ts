/**
 * Scored opportunities across every scanner.
 *
 * Returns rejected opportunities alongside taken ones, with the specific reason
 * for each rejection. That is the whole point of the Signals screen: it is how
 * you learn whether an edge is real *before* risking anything on it, and how
 * you debug why the system isn't trading (DESIGN.md §8.2).
 */

import { fetchSnapshot, fetchBinanceFundingHistory } from "@/lib/market/venues";
import { UNIVERSE } from "@/lib/market/types";
import { scan } from "@/lib/engine/scanner";
import {
  buildDataset,
  persistenceProbability,
  trainLogistic,
  type FundingSample,
} from "@/lib/ml/persistence";
import { readConfig } from "@/lib/engine/store";
import { PROMOTION_HOLD_DAYS, TIERS, tierForNav } from "@/lib/calc/tiers";
import { daysHeldAbove } from "@/lib/db/nav";
import { readHalt } from "@/lib/killswitch";
import { getNavUsd } from "@/lib/fund/nav";

export async function GET() {
  const [snapshot, storedConfig, haltState] = await Promise.all([
    fetchSnapshot(),
    readConfig(),
    readHalt(),
  ]);

  // NAV comes from the ledger, never from stored config — one source, so the
  // risk gate and the Treasury screen cannot disagree about how much money
  // there is.
  const prices = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.last > 0 && !prices.has(q.asset)) prices.set(q.asset, q.last);
  }
  const config = { ...storedConfig, navUsd: await getNavUsd(prices) };

  // Funding history drives the regime-persistence filter. Fetched per asset in
  // parallel; a failure degrades that asset to "no regime claim" rather than
  // failing the scan.
  const histories = await Promise.allSettled(
    UNIVERSE.map((a) =>
      fetchBinanceFundingHistory(a, Math.max(400, config.fundingRegimeWindow)),
    ),
  );

  const fundingHistory: Record<string, number[]> = {};
  const fundingSeries: Record<string, FundingSample[]> = {};
  histories.forEach((h, i) => {
    if (h.status === "fulfilled") {
      const key = `Binance:${UNIVERSE[i]}`;
      fundingSeries[key] = h.value.map((r) => ({ rate: r.rate, apr: r.apr }));
      fundingHistory[key] = h.value
        .slice(-config.fundingRegimeWindow)
        .map((r) => r.apr);
    }
  });

  // Shadow persistence probabilities, same as the trading pass computes.
  const persistence: Record<string, number> = {};
  const pooled = Object.values(fundingSeries).flatMap((s) => buildDataset(s));
  if (pooled.length >= 200) {
    const model = trainLogistic(pooled);
    for (const [key, s] of Object.entries(fundingSeries)) {
      const p = persistenceProbability(model, s);
      if (p !== null) persistence[key] = p;
    }
  }

  // The tier gate needs to know whether NAV has *held* above a threshold, which
  // requires recorded history. With the database down we pass zero days held,
  // so the ladder holds at T0 — the safe direction, since promotion loosens
  // limits and loosening on missing evidence is what the hold period prevents.
  let daysHeldAboveThreshold = 0;
  try {
    daysHeldAboveThreshold = await daysHeldAbove(tierForNav(config.navUsd).minNavUsd);
  } catch {
    daysHeldAboveThreshold = 0;
  }

  const opportunities = scan({
    config,
    snapshot,
    fundingHistory,
    daysHeldAboveThreshold,
    halted: haltState.halted,
    persistence,
  });

  return Response.json(
    {
      asOf: snapshot.asOf,
      errors: snapshot.errors,
      tier: {
        id: TIERS.find((t) => t.id === "T0")!.id,
        daysHeld: daysHeldAboveThreshold,
        holdDaysRequired: PROMOTION_HOLD_DAYS,
      },
      usingShadowSize: config.navUsd <= 0,
      notionalUsd:
        config.navUsd > 0
          ? config.navUsd * config.legNotionalPctOfNav
          : config.shadowNotionalUsd,
      opportunities,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
