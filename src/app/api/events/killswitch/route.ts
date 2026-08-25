// Global kill switch, stored in the shared database so it applies to every process
// (hosted dashboard, local engine, Compose workers) rather than one instance.
// Alerts stop; measurement continues, so the dry-run dataset stays whole.

import { NextResponse } from "next/server";
import { q, hasDb, schemaReady } from "@/lib/events/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readFlag(): Promise<boolean> {
  const rows = await q<{ value: unknown }>("SELECT value FROM runtime_flags WHERE key='kill_switch'");
  return rows[0]?.value === true || rows[0]?.value === "true";
}

export async function GET() {
  if (!hasDb() || !(await schemaReady())) {
    return NextResponse.json({ kill_switch: false, available: false });
  }
  try {
    return NextResponse.json({ kill_switch: await readFlag(), available: true });
  } catch (err) {
    return NextResponse.json({ kill_switch: false, available: false, error: (err as Error).message });
  }
}

export async function POST(req: Request) {
  if (!hasDb() || !(await schemaReady())) {
    return NextResponse.json({ error: "database not configured" }, { status: 503 });
  }
  let on = false;
  try {
    on = Boolean((await req.json())?.on);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    await q(
      `INSERT INTO runtime_flags(key, value, updated_at, updated_by)
       VALUES ('kill_switch', $1::jsonb, now(), 'dashboard')
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by='dashboard'`,
      [JSON.stringify(on)],
    );
    return NextResponse.json({ ok: true, kill_switch: on });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
