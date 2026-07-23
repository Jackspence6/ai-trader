/**
 * H1 crypto-trend backtest over real Binance daily candles.
 *
 * The evidence that funded the Systematic sleeve, kept live so it re-answers
 * itself as history accumulates instead of surviving as a one-off claim.
 */

import { runCryptoTrendBacktest } from "@/lib/backtest/runcryptotrend";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 1000, 200), 1000);

  try {
    const result = await runCryptoTrendBacktest({ days });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Crypto trend backtest failed" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
