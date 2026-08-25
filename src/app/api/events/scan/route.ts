// Polymarket scan trigger. Called by Vercel Cron (see vercel.json) and on demand
// from the dashboard's "Scan now" control.
//
// Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Manual calls may
// use ADMIN_TOKEN. A dry `?persist=false` run needs no auth — it writes nothing.

import { NextResponse } from "next/server";
import { scan } from "@/lib/events/scanner";
import { hasDb, schemaReady } from "@/lib/events/db";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const header = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const url = new URL(req.url);
  const qp = url.searchParams.get("token") ?? "";
  const secrets = [process.env.CRON_SECRET, process.env.ADMIN_TOKEN].filter(Boolean) as string[];
  if (!secrets.length) return false;
  return secrets.includes(header) || secrets.includes(qp);
}

async function handle(req: Request) {
  const url = new URL(req.url);
  const persist = url.searchParams.get("persist") !== "false";

  if (persist && !authorized(req)) {
    return NextResponse.json(
      { error: "unauthorized — pass CRON_SECRET/ADMIN_TOKEN, or use ?persist=false for a dry scan" },
      { status: 401 },
    );
  }
  if (persist && (!hasDb() || !(await schemaReady()))) {
    return NextResponse.json(
      { error: "database not migrated — POST /api/admin/migrate first" },
      { status: 503 },
    );
  }

  try {
    const tagsParam = url.searchParams.get("tags");
    const result = await scan({
      persist,
      tags: tagsParam ? tagsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      maxMarkets: Number(url.searchParams.get("max") ?? process.env.SCAN_MAX_MARKETS ?? 120),
    });
    return NextResponse.json({ ok: true, persisted: persist, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
