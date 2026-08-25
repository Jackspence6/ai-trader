import { NextResponse } from "next/server";
import { q, hasDb, schemaReady } from "@/lib/events/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID = new Set(["placed", "missed", "voided", "partial"]);

/** Operator feedback → capture rate + realized-vs-theoretical (spec §6). */
export async function POST(req: Request) {
  if (!hasDb() || !(await schemaReady())) {
    return NextResponse.json({ error: "database not configured" }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const oppId = String(body.opportunity_id ?? "");
  const status = String(body.status ?? "");
  if (!oppId || !VALID.has(status)) {
    return NextResponse.json({ error: "opportunity_id and a valid status are required" }, { status: 400 });
  }
  try {
    await q(
      `INSERT INTO placements(opportunity_id, status, leg_idx, actual_odds, actual_stake_zar, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [oppId, status, body.leg_idx ?? null, body.actual_odds ?? null,
       body.actual_stake_zar ?? null, body.note ?? null],
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
