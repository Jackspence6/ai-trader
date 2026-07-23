/**
 * FX book backtests over real multi-year daily history.
 *
 * The route that decided the forex allocations: F2 trend loses in every
 * tested parameter cell, F1 carry earns modestly with both components
 * positive. It stays live so the finding is reproducible and re-answers
 * itself as history accumulates.
 */

import { runFxBacktest } from "@/lib/backtest/runfx";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 1100, 200), 2000);

  try {
    const result = await runFxBacktest({ days });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "FX backtest failed" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
