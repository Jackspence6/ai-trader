/**
 * One-line state of the Event Markets desk, for the firm overview.
 *
 * Deliberately answers "is this desk alive and what is it holding" in a single
 * round trip, because the overview should not need four requests to say that a
 * desk has no capital and nothing running.
 */

import { NextResponse } from "next/server";
import { hasDb, schemaReady, q } from "@/lib/events/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const base = {
    configured: hasDb(),
    migrated: false,
    engineAlive: false,
    booksReporting: 0,
    booksIntegrated: 3,
    openOpportunities: 0,
    capitalZar: 0,
    fundedStrategies: 0,
    time: new Date().toISOString(),
  };

  if (!hasDb()) return NextResponse.json(base);

  try {
    const migrated = await schemaReady();
    if (!migrated) return NextResponse.json({ ...base, migrated });

    const [open] = await q<{ n: string }>(
      "select count(*)::text as n from opportunities where state='active'",
    );
    // A book counts as reporting only if it has been heard from recently; a row
    // written last week is not a heartbeat.
    const [books] = await q<{ n: string }>(
      `select count(distinct venue_id)::text as n from venue_health
       where ts > now() - interval '10 minutes'`,
    ).catch(() => [{ n: "0" }]);

    const booksReporting = Number(books?.n ?? 0);
    return NextResponse.json({
      ...base,
      migrated: true,
      engineAlive: booksReporting > 0,
      booksReporting,
      openOpportunities: Number(open?.n ?? 0),
    });
  } catch {
    return NextResponse.json(base);
  }
}
