/**
 * Funding-persistence model — trained and walk-forward validated on real
 * Binance funding history, on demand.
 *
 * Everything here is out-of-sample honesty: the walk-forward result is the
 * number that decides whether the model earns a place in the gate, and it is
 * always reported NEXT TO the naive baseline it must beat. The full-history
 * model at the end exists to price the CURRENT regime per asset — the same
 * probabilities the trading pass attaches to opportunities in shadow.
 */

import { fetchBinanceFundingHistory } from "@/lib/market/venues";
import { UNIVERSE } from "@/lib/market/types";
import {
  buildDataset,
  FEATURE_NAMES,
  FEATURE_WINDOW,
  persistenceProbability,
  trainLogistic,
  walkForward,
  type Example,
  type FundingSample,
} from "@/lib/ml/persistence";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const points = Math.min(Math.max(Number(url.searchParams.get("points")) || 1000, 200), 1000);

  const settled = await Promise.allSettled(
    UNIVERSE.map((a) => fetchBinanceFundingHistory(a, points)),
  );

  const byAsset: { asset: string; series: FundingSample[]; ts: number[] }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.length > FEATURE_WINDOW * 2) {
      byAsset.push({
        asset: UNIVERSE[i],
        series: r.value.map((p) => ({ rate: p.rate, apr: p.apr })),
        ts: r.value.map((p) => p.t),
      });
    }
  });

  if (byAsset.length === 0) {
    return Response.json(
      { error: "No funding history available from Binance" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  // Pool examples across assets, ordered by REAL timestamps so the
  // walk-forward split is chronological across the whole pool — an index sort
  // would misalign assets listed at different times.
  const pooled: Example[] = [];
  for (const a of byAsset) {
    for (const e of buildDataset(a.series)) {
      pooled.push({ ...e, i: a.ts[e.i] });
    }
  }

  const wf = walkForward(pooled);

  // Full-history model prices the current regime per asset.
  const model = trainLogistic(pooled);
  const current = byAsset.map((a) => ({
    asset: a.asset,
    probability: persistenceProbability(model, a.series),
    medianRuleSaysHold: (() => {
      const tail = a.series.slice(-FEATURE_WINDOW).map((p) => p.apr).sort((x, y) => x - y);
      const mid = Math.floor(tail.length / 2);
      const med = tail.length % 2 === 0 ? (tail[mid - 1] + tail[mid]) / 2 : tail[mid];
      return med > 0;
    })(),
  }));

  return Response.json(
    {
      points,
      assets: byAsset.length,
      walkForward: wf,
      current,
      weights: FEATURE_NAMES.map((name, k) => ({ name, weight: model.weights[k] })),
      caveats: [
        "Logistic regression on 5 regime features — deliberately small for the data size.",
        "Walk-forward validated: trained only on data before each test fold, never after.",
        "The label is economic: would the NEXT week of funding have summed positive.",
        "Shadow only — probabilities annotate opportunities; no gate uses them yet.",
        "Promotion bar: beat the median-rule baseline out-of-sample, or stay in shadow.",
      ],
    },
    { headers: { "cache-control": "no-store" } },
  );
}
