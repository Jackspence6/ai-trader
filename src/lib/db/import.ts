/**
 * Import recorded JSONL into the hypertables.
 *
 * This is the migration path the recorder was designed around: every line is
 * replayed in order, with no transformation beyond column mapping. That is why
 * the recorder writes append-only JSONL rather than something clever — the
 * import is a loop, and a loop is easy to trust.
 *
 * **Idempotent.** Every insert is `ON CONFLICT DO NOTHING` against a natural
 * key, so re-importing a day is safe. That matters more than it sounds: the
 * realistic operation is "import everything again after a crash", and an
 * importer that duplicates rows or aborts half-way turns a routine recovery
 * into a data-cleaning exercise.
 */

import type { PoolClient } from "pg";
import { getPool } from "./client";
import { listDays, readDay, type Stream } from "@/lib/recorder/store";

/** Rows per INSERT. Large enough to be fast, small enough to keep statements sane. */
const BATCH = 500;

export type ImportResult = {
  day: string;
  stream: Stream;
  read: number;
  inserted: number;
};

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Build a multi-row INSERT.
 *
 * Parameterised rather than interpolated — these values come from files we
 * wrote, but an importer that string-builds SQL is a habit that eventually
 * meets data someone else wrote.
 */
function insertSql(table: string, columns: string[], rowCount: number, conflict: string) {
  const placeholders: string[] = [];
  let p = 1;
  for (let i = 0; i < rowCount; i++) {
    placeholders.push(`(${columns.map(() => `$${p++}`).join(", ")})`);
  }
  return `INSERT INTO ${table} (${columns.join(", ")})
          VALUES ${placeholders.join(", ")}
          ON CONFLICT ${conflict} DO NOTHING`;
}

async function flush(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = insertSql(table, columns, rows.length, conflict);
  const res = await client.query(sql, rows.flat());
  return res.rowCount ?? 0;
}

/* ----------------------------------------------------------------- quotes */

const QUOTE_COLUMNS = [
  "recorded_at",
  "venue",
  "asset",
  "kind",
  "last",
  "bid",
  "ask",
  "spread_bps",
  "top_of_book_usd",
  "high_24h",
  "low_24h",
  "change_24h_pct",
  "volume_24h_usd",
  "funding_rate",
  "funding_interval_hours",
  "funding_apr",
  "next_funding_ms",
  "mark_price",
  "index_price",
  "open_interest_usd",
  "venue_ts",
  "error",
];

type QuoteRow = Record<string, unknown>;

function quoteValues(ts: number, d: QuoteRow): unknown[] {
  return [
    new Date(ts),
    d.venue,
    d.asset,
    d.kind,
    n(d.last),
    n(d.bid),
    n(d.ask),
    n(d.spreadBps),
    n(d.topOfBookUsd),
    n(d.high24h),
    n(d.low24h),
    n(d.change24hPct),
    n(d.volume24hUsd),
    n(d.fundingRate),
    n(d.fundingIntervalHours),
    n(d.fundingApr),
    n(d.nextFundingMs),
    n(d.markPrice),
    n(d.indexPrice),
    n(d.openInterestUsd),
    n(d.ts),
    d.error ?? null,
  ];
}

/* ---------------------------------------------------------------- funding */

const FUNDING_COLUMNS = ["funding_time", "venue", "asset", "rate", "apr", "recorded_at"];

/* ------------------------------------------------------------------- scan */

const SCAN_COLUMNS = [
  "recorded_at",
  "opportunity_id",
  "strategy",
  "strategy_name",
  "asset",
  "route",
  "risk_tier",
  "sleeve_id",
  "sleeve_name",
  "gross_bps",
  "fees_bps",
  "spread_bps",
  "slippage_bps",
  "drag_bps",
  "net_bps",
  "net_apr",
  "breakeven_days",
  "capital_required_usd",
  "notional_usd",
  "expected_profit_usd",
  "funding_apr",
  "taken",
  "would_take",
  "rejection_code",
  "rejection_detail",
];

function scanValues(ts: number, d: Record<string, unknown>): unknown[] {
  return [
    new Date(ts),
    d.id,
    d.strategy,
    d.strategyName ?? null,
    d.asset,
    d.route ?? null,
    d.riskTier ?? null,
    d.sleeveId ?? null,
    d.sleeveName ?? null,
    n(d.grossBps),
    n(d.feesBps),
    n(d.spreadBps),
    n(d.slippageBps),
    n(d.dragBps),
    n(d.netBps),
    n(d.netApr),
    n(d.breakevenDays),
    n(d.capitalRequiredUsd),
    n(d.notionalUsd),
    n(d.expectedProfitUsd),
    n(d.fundingApr),
    Boolean(d.taken),
    Boolean(d.wouldTake),
    d.rejectionCode ?? null,
    d.rejectionDetail ?? null,
  ];
}

/* -------------------------------------------------------------------- nav */

const NAV_COLUMNS = ["observed_at", "nav_usd", "source"];

/* ----------------------------------------------------------------- driver */

async function importStream(
  client: PoolClient,
  day: string,
  stream: Stream,
): Promise<ImportResult> {
  let read = 0;
  let inserted = 0;
  let batch: unknown[][] = [];

  const TABLES: Record<Stream, { table: string; columns: string[]; conflict: string }> = {
    quotes: {
      table: "quotes",
      columns: QUOTE_COLUMNS,
      conflict: "(recorded_at, venue, asset, kind)",
    },
    funding: {
      table: "funding",
      columns: FUNDING_COLUMNS,
      conflict: "(funding_time, venue, asset)",
    },
    scan: {
      table: "scan",
      columns: SCAN_COLUMNS,
      conflict: "(recorded_at, opportunity_id)",
    },
    nav: {
      table: "nav_history",
      columns: NAV_COLUMNS,
      conflict: "(observed_at)",
    },
  };
  const { table, columns, conflict } = TABLES[stream];

  for await (const env of readDay<Record<string, unknown>>(stream, day)) {
    const d = env.data;
    read++;

    if (stream === "quotes") {
      batch.push(quoteValues(env.ts, d));
    } else if (stream === "funding") {
      // Keyed on the venue's settlement time, not our observation time: the
      // same print is re-read on every poll and must collapse to one row.
      const t = n(d.t);
      if (t === null) continue;
      batch.push([new Date(t), d.venue, d.asset, n(d.rate), n(d.apr), new Date(env.ts)]);
    } else if (stream === "nav") {
      batch.push([new Date(env.ts), n(d.navUsd) ?? 0, d.source ?? "unknown"]);
    } else {
      batch.push(scanValues(env.ts, d));
    }

    if (batch.length >= BATCH) {
      inserted += await flush(client, table, columns, batch, conflict);
      batch = [];
    }
  }

  inserted += await flush(client, table, columns, batch, conflict);
  return { day, stream, read, inserted };
}

/**
 * Import one or more days.
 *
 * Each (day, stream) is committed separately rather than wrapping the whole
 * import in one transaction. A year of recordings in a single transaction would
 * hold locks for minutes and lose everything on one bad row; per-chunk commits
 * mean an interrupted import keeps its progress and the re-run skips it.
 */
export async function importDays(
  days?: string[],
  log: (msg: string) => void = () => {},
): Promise<ImportResult[]> {
  const targets = days && days.length > 0 ? days : await listDays();
  const results: ImportResult[] = [];
  const client = await getPool().connect();

  try {
    for (const day of targets) {
      for (const stream of ["quotes", "funding", "scan", "nav"] as Stream[]) {
        await client.query("BEGIN");
        try {
          const r = await importStream(client, day, stream);
          await client.query("COMMIT");
          if (r.read > 0) {
            log(
              `${day} ${stream.padEnd(7)} read ${String(r.read).padStart(7)} · inserted ${String(r.inserted).padStart(7)}`,
            );
          }
          results.push(r);
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      }
    }
  } finally {
    client.release();
  }

  return results;
}
