/**
 * Event Markets database access.
 *
 * The two desks share one Postgres and are separated by schema: the Asset
 * Markets tables sit in `public`, this desk's in `events`. That is not
 * fastidiousness — both desks have a natural table called `markets` and a
 * natural table called `events`, and a shared namespace would have made one
 * of them lie.
 *
 * `search_path` is set per query rather than per pool so that a connection
 * borrowed by this desk can never leave the path changed for the next caller,
 * which is the failure mode that makes schema separation worse than no
 * separation at all.
 *
 * Two drivers, picked by host: Neon's serverless pool over its WebSocket proxy
 * for *.neon.tech, and node-postgres for anything else — Compose, the local
 * 24/7 box, a plain managed Postgres. Both satisfy the same small surface, so
 * nothing downstream knows the difference.
 */

import { Pool as NeonPool } from "@neondatabase/serverless";
import { getPool as firmPool, databaseUrl, databaseConfigured } from "@/lib/db/client";

export const EVENTS_SCHEMA = "events";

let neon: NeonPool | null = null;

export function dbUrl(): string | null {
  return databaseConfigured() ? databaseUrl() : null;
}

export function hasDb(): boolean {
  return databaseConfigured();
}

export function isNeon(url: string): boolean {
  return /neon\.tech|neon\.build/i.test(url);
}

/**
 * The pool this desk borrows from.
 *
 * On anything but Neon this is the *firm's* pool, not a second one. Two pools
 * against the same database doubles the connection count for no benefit, and
 * before this they also resolved their connection strings separately — so a box
 * with `DB_URL` set but not `DATABASE_URL` had the two desks pointed at
 * different databases while both reported healthy.
 *
 * Neon keeps its own pool because its serverless driver speaks a WebSocket
 * protocol that node-postgres cannot, and the hosted deployment still needs it.
 */
function pool() {
  const url = dbUrl();
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!isNeon(url)) return firmPool();
  if (!neon) neon = new NeonPool({ connectionString: url });
  return neon;
}

/** Minimal client surface both drivers satisfy — the union of their own types
 *  isn't callable, so consumers go through this instead. */
export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/** Checked-out connection for multi-statement work (migrations, transactions),
 *  already pointed at this desk's schema. */
export async function getClient(): Promise<DbClient> {
  const client = (await (pool() as { connect: () => Promise<unknown> }).connect()) as DbClient;
  await client.query(`SET search_path TO ${EVENTS_SCHEMA}, public`);
  return client;
}

/** Run a query against this desk's schema. Returns [] when no database is
 *  configured, so every screen degrades to its demo state rather than erroring. */
export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!hasDb()) return [];
  const client = await getClient();
  try {
    const res = await client.query(sql, params);
    return res.rows as T[];
  } finally {
    client.release();
  }
}

/** True when this desk's schema has been migrated. */
export async function schemaReady(): Promise<boolean> {
  if (!hasDb()) return false;
  try {
    const rows = await q<{ ok: boolean }>(
      `select to_regclass('${EVENTS_SCHEMA}.opportunities') is not null as ok`,
    );
    return Boolean(rows[0]?.ok);
  } catch {
    return false;
  }
}
