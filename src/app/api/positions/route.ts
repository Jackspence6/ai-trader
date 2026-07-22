/**
 * Positions, PnL and delta exposure — derived from the fill log.
 *
 * Everything here is paper. The venue that produced these fills cannot reach an
 * exchange, and the response says so explicitly rather than leaving it to be
 * inferred from context — a positions screen that does not state whether it is
 * real is the worst kind of ambiguous.
 */

import { readFills, readFundingPayments } from "@/lib/oms/store";
import {
  assetDelta,
  buildPositions,
  markPositions,
  sleevePnl,
} from "@/lib/portfolio/positions";
import { fetchSnapshot } from "@/lib/market/venues";
import { fetchFxQuotes } from "@/lib/market/forex";
import { fxPrices } from "@/lib/market/fxbook";

export async function GET() {
  const [fills, funding, snapshot, fx] = await Promise.all([
    readFills(),
    readFundingPayments(),
    fetchSnapshot(),
    fetchFxQuotes().catch(() => []),
  ]);

  const prices = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.kind === "spot" && q.last > 0 && !prices.has(q.asset)) {
      prices.set(q.asset, q.last);
    }
  }
  // Perp marks fill any gaps — some assets have no spot book on our venues.
  for (const q of snapshot.quotes) {
    if (q.last > 0 && !prices.has(q.asset)) prices.set(q.asset, q.last);
  }
  // FX pair rates so forex positions mark too — same key their fills use.
  for (const [symbol, rate] of fxPrices(fx)) prices.set(symbol, rate);

  const positions = buildPositions(fills, funding);
  const marked = markPositions(positions, prices);
  const open = marked.filter((p) => p.qty !== 0);

  const delta = [...assetDelta(marked).entries()]
    .map(([asset, qty]) => ({
      asset,
      qty,
      usd: (prices.get(asset) ?? 0) * qty,
    }))
    .filter((d) => Math.abs(d.qty) > 1e-12);

  const anyUnmarked = open.some((p) => p.markPrice === null);

  return Response.json(
    {
      mode: "paper",
      isLive: false,
      positions: marked,
      open: open.length,
      sleeves: sleevePnl(marked),
      delta,
      totals: {
        realisedUsd: marked.reduce((a, p) => a + p.realisedUsd, 0),
        fundingUsd: marked.reduce((a, p) => a + p.fundingUsd, 0),
        feesUsd: marked.reduce((a, p) => a + p.feesUsd, 0),
        // One unmarkable position makes the total unknowable. Summing the rest
        // would understate it while looking precise.
        unrealisedUsd: anyUnmarked
          ? null
          : open.reduce((a, p) => a + (p.unrealisedUsd ?? 0), 0),
        grossExposureUsd: anyUnmarked
          ? null
          : open.reduce((a, p) => a + Math.abs(p.marketValueUsd ?? 0), 0),
        netExposureUsd: anyUnmarked
          ? null
          : open.reduce((a, p) => a + (p.marketValueUsd ?? 0), 0),
      },
      fillCount: fills.length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
