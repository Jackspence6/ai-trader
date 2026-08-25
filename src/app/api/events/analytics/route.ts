// Dry-run analytics + go/no-go metric (spec §6), computed in SQL over the same
// tables backend/oddsengine/analytics.py summarizes.

import { NextResponse } from "next/server";
import { q, hasDb, schemaReady } from "@/lib/events/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USABLE_MARGIN_PCT = 1.0;
const USABLE_EXEC_ZAR = 2000;
const TARGET_PER_DAY = 3;
const DRY_RUN_DAYS = 14;

function quantiles(values: number[]) {
  if (!values.length) return { p25: 0, p50: 0, p75: 0, p95: 0 };
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95) };
}

function histogram(values: number[], edges: number[]) {
  return edges.map((lo, i) => {
    const hi = i + 1 < edges.length ? edges[i + 1] : Infinity;
    const count = values.filter((v) => v >= lo && v < hi).length;
    return { bucket: hi === Infinity ? `${lo}+` : `${lo}–${hi}`, count };
  });
}

export async function GET() {
  if (!hasDb() || !(await schemaReady())) {
    return NextResponse.json({ source: "unconfigured" }, { status: 200 });
  }
  try {
    const opps = await q<{
      id: string; margin_pct: number; executable_zar_per_leg: number | null;
      window_s: number | null; guaranteed_profit_zar: number | null;
      opp_type: string; first_seen: string;
    }>(
      `SELECT id, margin_pct, executable_zar_per_leg, window_s, guaranteed_profit_zar,
              opp_type, first_seen FROM opportunities`,
    );
    const placements = await q<{ opportunity_id: string; status: string }>(
      `SELECT opportunity_id, status FROM placements`,
    );

    const usable = opps.filter(
      (o) => Number(o.margin_pct) >= USABLE_MARGIN_PCT &&
             Number(o.executable_zar_per_leg ?? 0) >= USABLE_EXEC_ZAR,
    );
    const days = new Set(opps.map((o) => new Date(o.first_seen).toISOString().slice(0, 10)));
    const daysObserved = days.size;

    const byDay: Record<string, number> = {};
    for (const o of usable) {
      const d = new Date(o.first_seen).toISOString().slice(0, 10);
      byDay[d] = (byDay[d] ?? 0) + 1;
    }
    const byType: Record<string, number> = {};
    for (const o of opps) byType[o.opp_type] = (byType[o.opp_type] ?? 0) + 1;

    const placedIds = new Set(placements.filter((p) => p.status === "placed").map((p) => p.opportunity_id));
    const captureRate = usable.length
      ? usable.filter((o) => placedIds.has(o.id)).length / usable.length
      : 0;

    const theoretical = usable.reduce((a, o) => a + Number(o.guaranteed_profit_zar ?? 0), 0);
    const realized = opps
      .filter((o) => placedIds.has(o.id))
      .reduce((a, o) => a + Number(o.guaranteed_profit_zar ?? 0), 0);

    const margins = opps.map((o) => Number(o.margin_pct));
    const windows = opps.filter((o) => o.window_s != null).map((o) => Number(o.window_s));
    const execs = opps
      .filter((o) => o.executable_zar_per_leg != null)
      .map((o) => Number(o.executable_zar_per_leg));

    const usablePerDay = daysObserved ? usable.length / daysObserved : 0;
    const goNoGo =
      daysObserved >= DRY_RUN_DAYS
        ? usablePerDay >= TARGET_PER_DAY ? "GO" : "NO-GO"
        : "PENDING";

    const placementCounts: Record<string, number> = { placed: 0, missed: 0, voided: 0, partial: 0 };
    for (const p of placements) {
      if (p.status in placementCounts) placementCounts[p.status] += 1;
    }

    return NextResponse.json({
      source: "db",
      days_observed: daysObserved,
      opportunities_total: opps.length,
      usable_total: usable.length,
      usable_per_day: Number(usablePerDay.toFixed(2)),
      target_per_day: TARGET_PER_DAY,
      dry_run_days_target: DRY_RUN_DAYS,
      go_no_go: goNoGo,
      margin_pct: quantiles(margins),
      margin_histogram: histogram(margins, [0, 0.5, 1, 1.5, 2, 3, 5, 8]),
      window_s: quantiles(windows),
      window_histogram: histogram(windows, [0, 5, 15, 30, 60, 120, 300, 600]),
      executable_zar: quantiles(execs),
      capture_rate: Number(captureRate.toFixed(3)),
      theoretical_profit_zar: Number(theoretical.toFixed(2)),
      realized_profit_zar: Number(realized.toFixed(2)),
      by_type: byType,
      by_day: Object.fromEntries(Object.entries(byDay).sort()),
      placements: placementCounts,
    });
  } catch (err) {
    return NextResponse.json({ source: "error", error: (err as Error).message }, { status: 500 });
  }
}
