/**
 * Postgres / TimescaleDB client.
 *
 * **Optional by design.** Nothing in the live path blocks on this being up:
 * the recorder writes files, the dashboard reads files, and the database is the
 * analytical store that the importer fills and the backtester reads. If Docker
 * is not running, everything that matters keeps working.
 *
 * That is not laziness about infrastructure — it is the same reasoning as the
 * recorder. A component whose failure is silent and unrecoverable (missed
 * evidence) must not depend on a component whose failure is routine (a daemon
 * that did not come back after a reboot).
 */

import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * Connection string.
 *
 * Port 5433 by default to match docker-compose, which deliberately avoids
 * colliding with a Postgres someone already runs on 5432.
 */
export function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgresql://trader:trader@localhost:5433/aitrader"
  );
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      // Small pool: this is a single-operator system, and a large pool just
      // means more connections to leak when something goes wrong.
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // A pool-level error handler is mandatory — without one, a dropped backend
    // connection raises an unhandled 'error' event and takes the process down.
    pool.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(sql, params);
  return res.rows;
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Extract a usable message from a connection failure.
 *
 * Node's dual-stack connect raises an `AggregateError` whose own `message` is
 * empty — the real cause is in `.errors`. Reporting that empty string gives
 * "Database DOWN — " with no reason, which is worse than useless when the
 * whole point of the status call is to say what is wrong.
 */
export function describeError(e: unknown): string {
  if (e instanceof AggregateError && e.errors.length > 0) {
    const inner = e.errors
      .map((x) => (x instanceof Error ? x.message : String(x)))
      .filter(Boolean);
    if (inner.length > 0) return [...new Set(inner)].join("; ");
  }
  if (e instanceof Error && e.message) return e.message;
  return String(e) || "unknown error";
}

export type DbStatus =
  | { up: true; version: string; timescale: string | null }
  | { up: false; error: string };

/**
 * Is the database reachable?
 *
 * Returns a status rather than throwing, because "not running" is an ordinary
 * state here, not an exception. Callers render it; they do not handle it.
 */
export async function status(): Promise<DbStatus> {
  try {
    const rows = await query<{ version: string }>("SELECT version()");
    let timescale: string | null = null;
    try {
      const ext = await query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
      );
      timescale = ext[0]?.extversion ?? null;
    } catch {
      timescale = null;
    }
    return {
      up: true,
      version: rows[0]?.version.split(" ").slice(0, 2).join(" ") ?? "unknown",
      timescale,
    };
  } catch (e) {
    return { up: false, error: describeError(e) };
  }
}
