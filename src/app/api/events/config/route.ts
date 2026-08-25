// Deployment-visible config for the Settings screen. Mirrors the shape the FastAPI
// /config returns so one screen renders either source. Secrets are never included.

import { NextResponse } from "next/server";
import { hasDb, schemaReady, q } from "@/lib/events/db";
import { DEFAULT_WEIGHTS } from "@/lib/events/scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let killSwitch = false;
  let dbReady = false;
  if (hasDb()) {
    try {
      dbReady = await schemaReady();
      if (dbReady) {
        const rows = await q<{ value: unknown }>("SELECT value FROM runtime_flags WHERE key='kill_switch'");
        killSwitch = rows[0]?.value === true || rows[0]?.value === "true";
      }
    } catch { /* reported below via database_ready */ }
  }
  return NextResponse.json({
    source: "vercel",
    engine: {
      min_margin_pct: Number(process.env.SCAN_MIN_MARGIN_PCT ?? 0.5),
      min_executable_zar: Number(process.env.SCAN_MIN_EXECUTABLE_ZAR ?? 2000),
      total_stake_default_zar: Number(process.env.SCAN_TOTAL_STAKE_ZAR ?? 10000),
      max_markets_per_scan: Number(process.env.SCAN_MAX_MARKETS ?? 120),
      slippage_bps: Number(process.env.SCAN_SLIPPAGE_BPS ?? 50),
    },
    scoring_weights: DEFAULT_WEIGHTS,
    polling: {
      dashboard_poll_ms: Number(process.env.NEXT_PUBLIC_POLL_MS ?? 6000),
      fx_buffer_pct: Number(process.env.FX_BUFFER_PCT ?? 2),
    },
    alerts: { dry_run: true },
    database_ready: dbReady,
    kill_switch: killSwitch,
  });
}
