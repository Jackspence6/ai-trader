/**
 * Migration runner.
 *
 * Deliberately primitive: numbered `.sql` files applied in order, each recorded
 * in a `schema_migrations` table, each wrapped in a transaction. No ORM, no
 * rollback machinery, no down-migrations.
 *
 * Down-migrations are omitted on purpose. In a system whose whole point is an
 * unbroken record of what we observed, the recovery path for a bad migration is
 * a new forward migration — not an automated undo that might drop a hypertable
 * chunk nobody can recreate.
 *
 * Each file's checksum is stored, and a changed file that has already been
 * applied is an error rather than a silent no-op: editing an applied migration
 * means two environments have silently different schemas.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getPool, query, transaction } from "./client";

export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "db", "migrations");
}

export type Migration = {
  name: string;
  sql: string;
  checksum: string;
};

export type AppliedMigration = {
  name: string;
  checksum: string;
  applied_at: Date;
};

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

export async function loadMigrations(): Promise<Migration[]> {
  const dir = migrationsDir();
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }

  return Promise.all(
    files.map(async (name) => {
      const sql = await fs.readFile(path.join(dir, name), "utf-8");
      return { name, sql, checksum: checksum(sql) };
    }),
  );
}

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text        PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function appliedMigrations(): Promise<AppliedMigration[]> {
  await ensureMigrationsTable();
  return query<AppliedMigration>(
    "SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name",
  );
}

export type MigrateResult = {
  applied: string[];
  skipped: string[];
};

/**
 * Apply every pending migration, in order.
 *
 * Each runs in its own transaction, so a failure leaves the database at the
 * last complete migration rather than half-way through one.
 */
export async function migrate(
  log: (msg: string) => void = () => {},
): Promise<MigrateResult> {
  await ensureMigrationsTable();

  const all = await loadMigrations();
  const done = new Map((await appliedMigrations()).map((m) => [m.name, m.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const m of all) {
    const existing = done.get(m.name);

    if (existing !== undefined) {
      if (existing !== m.checksum) {
        throw new Error(
          `Migration ${m.name} has changed since it was applied ` +
            `(stored ${existing}, file ${m.checksum}). ` +
            `Editing an applied migration leaves environments with silently ` +
            `different schemas — add a new migration instead.`,
        );
      }
      skipped.push(m.name);
      continue;
    }

    log(`applying ${m.name}`);
    await transaction(async (client) => {
      await client.query(m.sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [m.name, m.checksum],
      );
    });
    applied.push(m.name);
  }

  return { applied, skipped };
}

/** Pending migrations, without applying them. */
export async function pendingMigrations(): Promise<string[]> {
  const all = await loadMigrations();
  const done = new Set((await appliedMigrations()).map((m) => m.name));
  return all.filter((m) => !done.has(m.name)).map((m) => m.name);
}

/** Table row counts, for the status command. */
export async function tableCounts(): Promise<Record<string, number>> {
  const tables = ["quotes", "funding", "scan", "nav_history"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    try {
      const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
      out[t] = Number(rows[0]?.n ?? 0);
    } catch {
      // Table does not exist yet — report as absent rather than failing the
      // whole status call.
      out[t] = -1;
    }
  }
  return out;
}

export { getPool };
