/**
 * Performance attribution.
 *
 * Everything is derived from the fill log and the pass log, so nothing here can
 * disagree with what actually happened.
 */

import { buildReport } from "@/lib/engine/performance";
import { currentPrices } from "@/lib/fund/nav";
import { getFundState } from "@/lib/fund/nav";

export async function GET() {
  const prices = await currentPrices();
  const [report, fund] = await Promise.all([buildReport(prices), getFundState(prices)]);

  return Response.json(
    {
      report,
      nav: {
        navUsd: fund.navUsd,
        netContributedUsd: fund.netContributedUsd,
        performanceIndex: fund.performanceIndex,
        twrPct: fund.twrPct,
        nature: fund.nature,
      },
      pnl: fund.pnl,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
