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
import { readConfig } from "@/lib/engine/store";

export async function GET() {
  const [snapshot, config] = await Promise.all([fetchSnapshot(), readConfig()]);

  // Funding history drives the regime-persistence filter. Fetched per asset in
  // parallel; a failure degrades that asset to "no regime claim" rather than
  // failing the scan.
  const histories = await Promise.allSettled(
    UNIVERSE.map((a) => fetchBinanceFundingHistory(a, config.fundingRegimeWindow)),
  );

  const fundingHistory: Record<string, number[]> = {};
  histories.forEach((h, i) => {
    if (h.status === "fulfilled") {
      fundingHistory[`Binance:${UNIVERSE[i]}`] = h.value.map((r) => r.apr);
    }
  });

  const opportunities = scan({ config, snapshot, fundingHistory });

  return Response.json(
    {
      asOf: snapshot.asOf,
      errors: snapshot.errors,
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
