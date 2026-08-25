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
import { Pool as PgPool } from "pg";

export type AnyPool = NeonPool | PgPool;

export const EVENTS_SCHEMA = "events";

let pool: AnyPool | null = null;

export function dbUrl(): string | null {
  return process.env.DATABASE_URL ?? process.env.DB_URL ?? null;
}

export function hasDb(): boolean {
  return Boolean(dbUrl());
}

export function isNeon(url: string): boolean {
  return /neon\.tech|neon\.build/i.test(url);
}

export function getPool(): AnyPool {
  const url = dbUrl();
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    pool = isNeon(url)
      ? new NeonPool({ connectionString: url })
      : new PgPool({
          connectionString: url,
          ssl: /sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined,
          max: 5,
        });
  }
  return pool;
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
  const client = (await (getPool() as PgPool).connect()) as unknown as DbClient;
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
