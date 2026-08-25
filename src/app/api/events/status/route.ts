// Deployment self-check: what's wired, what isn't. First stop when the hosted
// dashboard looks empty.

import { NextResponse } from "next/server";
import { hasDb, schemaReady, q } from "@/lib/events/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = {
    ok: true,
    database_url_set: hasDb(),
    admin_token_set: Boolean(process.env.ADMIN_TOKEN),
    cron_secret_set: Boolean(process.env.CRON_SECRET),
    schema_migrated: false,
    counts: {},
    time: new Date().toISOString(),
  };
  if (hasDb()) {
    try {
      const ready = await schemaReady();
      out.schema_migrated = ready;
      if (ready) {
        const [opps] = await q<{ n: string }>("select count(*)::text as n from opportunities");
        const [active] = await q<{ n: string }>("select count(*)::text as n from opportunities where state='active'");
        const [snaps] = await q<{ n: string }>("select count(*)::text as n from odds_snapshots");
        const [placements] = await q<{ n: string }>("select count(*)::text as n from placements");
        out.counts = {
          opportunities: Number(opps?.n ?? 0),
          active: Number(active?.n ?? 0),
          odds_snapshots: Number(snaps?.n ?? 0),
          placements: Number(placements?.n ?? 0),
        };
      }
    } catch (err) {
      out.ok = false;
      out.error = (err as Error).message;
    }
  }
  return NextResponse.json(out);
}
