// Opportunities feed for the hosted dashboard — reads the same tables the Python
// engine writes. Vercel has no long-lived WebSocket, so the client polls this.

import { NextResponse } from "next/server";
import { q, hasDb, schemaReady } from "@/lib/events/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LegRow {
  opportunity_id: string; idx: number; venue_id: string; outcome: string;
  selection_label: string | null; odds: number; raw_price: number | null;
  fee_rate: number | null; stake_zar: number | null; deep_link: string | null;
  rules_group: string | null; is_pm: boolean; token_id: string | null;
  max_stake_zar: number | null; order_index: number | null;
}

const VENUE_NAMES: Record<string, string> = {
  polymarket: "Polymarket", betway_sa: "Betway SA", hollywoodbets: "Hollywoodbets",
  supabets: "Supabets", sunbet: "Sunbet", betmock_a: "MockBet Alpha",
  betmock_b: "MockBet Bravo", betmock_c: "MockBet Charlie",
};

export async function GET(req: Request) {
  if (!hasDb()) {
    return NextResponse.json({ source: "unconfigured", opportunities: [] });
  }
  if (!(await schemaReady())) {
    return NextResponse.json(
      { source: "unmigrated", opportunities: [], hint: "POST /api/admin/migrate with ADMIN_TOKEN" },
    );
  }

  const url = new URL(req.url);
  const stateFilter = url.searchParams.get("state") ?? "active";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);

  try {
    const where = stateFilter === "all" ? "" : "WHERE state = 'active'";
    const opps = await q<Record<string, unknown>>(
      `SELECT * FROM opportunities ${where} ORDER BY state = 'active' DESC, score DESC LIMIT $1`,
      [limit],
    );
    if (opps.length === 0) return NextResponse.json({ source: "db", opportunities: [] });

    const ids = opps.map((o) => o.id as string);
    const legs = await q<LegRow>(
      `SELECT * FROM opportunity_legs WHERE opportunity_id = ANY($1) ORDER BY opportunity_id, idx`,
      [ids],
    );
    const byOpp = new Map<string, LegRow[]>();
    for (const l of legs) {
      if (!byOpp.has(l.opportunity_id)) byOpp.set(l.opportunity_id, []);
      byOpp.get(l.opportunity_id)!.push(l);
    }

    const shaped = opps.map((o) => ({
      ...o,
      score_breakdown: o.score_breakdown ?? {},
      notes: o.notes ?? [],
      executable_zar_per_leg: o.executable_zar_per_leg ?? 0,
      legs: (byOpp.get(o.id as string) ?? []).map((l) => ({
        venue_id: l.venue_id,
        venue_name: VENUE_NAMES[l.venue_id] ?? l.venue_id,
        outcome: l.outcome,
        selection_label: l.selection_label ?? l.outcome,
        odds: Number(l.odds),
        raw_price: l.raw_price,
        fee_rate: l.fee_rate,
        stake_zar: Number(l.stake_zar ?? 0),
        deep_link: l.deep_link ?? "",
        rules_group: l.rules_group ?? "UNVERIFIED",
        is_pm: Boolean(l.is_pm),
        token_id: l.token_id,
        max_stake_zar: l.max_stake_zar,
        order_index: l.order_index ?? 1,
      })),
    }));
    return NextResponse.json({ source: "db", opportunities: shaped });
  } catch (err) {
    return NextResponse.json(
      { source: "error", opportunities: [], error: (err as Error).message },
      { status: 500 },
    );
  }
}
