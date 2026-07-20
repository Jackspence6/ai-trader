/**
 * Price history plus derived indicators for one asset.
 *
 * The indicators are computed server-side from the same pure functions the
 * strategies use, so what the chart shows and what the engine decides on can
 * never drift apart — DESIGN.md principle 1, applied to the dashboard.
 */

import { fetchCandles, fetchBinanceFundingHistory } from "@/lib/market/venues";
import { isUniverseAsset } from "@/lib/market/types";
import { atr, donchian, ema, latest, realisedVol, rsi } from "@/lib/calc/indicators";
import { classifyFundingRegime } from "@/lib/calc/funding";

const ALLOWED_INTERVALS = new Set(["1h", "4h", "1d", "1w"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const asset = (url.searchParams.get("asset") ?? "BTC").toUpperCase();
  const interval = url.searchParams.get("interval") ?? "1d";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 180) || 180, 500);

  // Validate against the known universe rather than passing user input through
  // to an exchange URL.
  if (!isUniverseAsset(asset)) {
    return Response.json({ error: `Unsupported asset: ${asset}` }, { status: 400 });
  }
  if (!ALLOWED_INTERVALS.has(interval)) {
    return Response.json({ error: `Unsupported interval: ${interval}` }, { status: 400 });
  }

  try {
    const [candles, funding] = await Promise.all([
      fetchCandles(asset, interval, limit),
      fetchBinanceFundingHistory(asset, 90).catch(() => []),
    ]);

    const closes = candles.map((c) => c.c);
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const atr14 = atr(highs, lows, closes, 14);
    const rsi14 = rsi(closes, 14);
    const { upper, lower } = donchian(highs, lows, 20);
    const price = closes[closes.length - 1] ?? 0;
    const atrNow = latest(atr14);

    return Response.json(
      {
        asset,
        interval,
        candles,
        series: { ema20, ema50, donchianUpper: upper, donchianLower: lower },
        indicators: {
          price,
          ema20: latest(ema20),
          ema50: latest(ema50),
          rsi14: latest(rsi14),
          atr14: atrNow,
          /** ATR as a share of price — the comparable cross-asset measure. */
          atrPct: atrNow && price > 0 ? atrNow / price : null,
          realisedVol30d: realisedVol(closes, 365, 30),
          realisedVol90d: realisedVol(closes, 365, 90),
        },
        funding: {
          history: funding,
          regime: classifyFundingRegime(funding.map((f) => f.apr)),
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Upstream fetch failed" },
      { status: 502 },
    );
  }
}
