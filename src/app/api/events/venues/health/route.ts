import { NextResponse } from "next/server";
import { q, hasDb, schemaReady } from "@/lib/events/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Venue health for the hosted dashboard.
 *  Adapter health is hot state (Redis) in the full stack; here it is derived from
 *  the freshest odds_snapshots row per venue, which is what the DB actually knows. */
export async function GET() {
  if (!hasDb() || !(await schemaReady())) {
    return NextResponse.json({ source: "unconfigured", health: {} });
  }
  try {
    const rows = await q<{ venue_id: string; last_ts: string; n: string }>(
      `SELECT venue_id, max(ts) AS last_ts, count(*) AS n
         FROM odds_snapshots
        WHERE ts > now() - interval '24 hours'
        GROUP BY venue_id`,
    );
    const health: Record<string, unknown> = {};
    for (const r of rows) {
      const staleness = (Date.now() - new Date(r.last_ts).getTime()) / 1000;
      const streaming = r.venue_id === "polymarket";
      const state = staleness > (streaming ? 300 : 120) ? "stale" : "ok";
      health[r.venue_id] = {
        venue_id: r.venue_id, state, last_success: r.last_ts, error_rate: 0,
        consecutive_errors: 0, staleness_s: staleness,
        note: `${Number(r.n).toLocaleString()} snapshots in 24h`,
        ts: new Date().toISOString(),
      };
    }
    for (const v of ["betway_sa", "hollywoodbets", "supabets", "sunbet"]) {
      if (!health[v]) {
        health[v] = {
          venue_id: v, state: "unconfigured", last_success: null, error_rate: 0,
          consecutive_errors: 0, staleness_s: null,
          note: "endpoints not discovered yet — see ops/runbook.md §1",
          ts: new Date().toISOString(),
        };
      }
    }
    return NextResponse.json({ source: "db", health });
  } catch (err) {
    return NextResponse.json({ source: "error", health: {}, error: (err as Error).message }, { status: 500 });
  }
}
