// Self-migration endpoint: runs db/migrations/*.sql against the configured Neon
// database. Exists because the build/authoring environment cannot reach Neon —
// the deployed app migrates itself on first call.
//
// Protected by ADMIN_TOKEN (Bearer or ?token=). If ADMIN_TOKEN is unset the route
// refuses to run at all rather than defaulting open.

import { NextResponse } from "next/server";
import { getClient, hasDb } from "@/lib/events/db";
import { MIGRATIONS } from "@/lib/events/migrations.generated";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.replace(/^Bearer\s+/i, "");
  const url = new URL(req.url);
  const qp = url.searchParams.get("token") ?? "";
  return bearer === expected || qp === expected;
}

async function runMigrations() {
  const client = await getClient();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    const done = new Set(rows.map((r) => String(r.filename)));
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) { skipped.push(m.name); continue; }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations(filename) VALUES($1)", [m.name]);
        await client.query("COMMIT");
        applied.push(m.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
  return { applied, skipped };
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "unauthorized — set ADMIN_TOKEN in the environment and pass it as a Bearer token" },
      { status: 401 },
    );
  }
  if (!hasDb()) {
    return NextResponse.json({ error: "DATABASE_URL is not set" }, { status: 500 });
  }
  try {
    const result = await runMigrations();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
