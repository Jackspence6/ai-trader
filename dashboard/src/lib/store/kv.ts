/**
 * Durable key/value state, backed by Postgres or by local files.
 *
 * Four things need to survive a restart and be shared between the dashboard and
 * the engine: engine config, halt state, the credential vault, and the paper
 * book. All four were local JSON files, which works on a box you own and does
 * not work at all on a serverless host with a read-only, ephemeral filesystem.
 *
 * So this is one narrow interface with two backends:
 *
 *   - **Postgres** when `DATABASE_URL` is set. The only option on Vercel.
 *   - **Files** otherwise. Keeps a local checkout working with no database,
 *     and keeps the recorder and kill switch usable when Docker is not running.
 *
 * The backend is chosen by environment, never by a code path a caller picks —
 * so there is no way for one component to write to files while another reads
 * from Postgres and quietly disagrees about the state of the world.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type StoreBackend = "postgres" | "file";

export function backend(): StoreBackend {
  return process.env.DATABASE_URL ? "postgres" : "file";
}

export function backendDescription(): string {
  return backend() === "postgres"
    ? "Postgres (DATABASE_URL is set)"
    : "Local files (.data/) — set DATABASE_URL to use Postgres";
}

function filePathFor(key: string): string {
  const base = process.env.STATE_DIR ?? path.join(process.cwd(), ".data");
  // Keys are internal constants, never user input, but a key containing a
  // path separator would still escape the directory — so it cannot.
  return path.join(base, `${key.replace(/[^a-z0-9_-]/gi, "_")}.json`);
}

/**
 * Read a JSON value.
 *
 * Returns null when absent. Throws only when the store itself is broken — a
 * missing key and an unreachable database are genuinely different situations,
 * and callers that fail safe need to tell them apart.
 */
export async function readJson<T>(key: string): Promise<T | null> {
  if (backend() === "postgres") {
    const { query } = await import("@/lib/db/client");
    const rows = await query<{ value: unknown }>(
      "SELECT value FROM app_state WHERE key = $1",
      [key],
    );
    return (rows[0]?.value as T) ?? null;
  }

  try {
    return JSON.parse(await fs.readFile(filePathFor(key), "utf-8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
}

export async function writeJson<T>(key: string, value: T): Promise<void> {
  if (backend() === "postgres") {
    const { query } = await import("@/lib/db/client");
    await query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    return;
  }

  const file = filePathFor(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Temp file plus rename: atomic on POSIX, so a crash mid-write cannot leave
  // a half-written state file behind.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await fs.rename(tmp, file);
  // The vault is in here; there is no reason for any of it to be group- or
  // world-readable.
  await fs.chmod(file, 0o600);
}

export async function deleteKey(key: string): Promise<void> {
  if (backend() === "postgres") {
    const { query } = await import("@/lib/db/client");
    await query("DELETE FROM app_state WHERE key = $1", [key]);
    return;
  }
  await fs.rm(filePathFor(key), { force: true });
}

/* --------------------------------------------------------------- append log */

/**
 * Append to an ordered log (audit trails, fills, orders).
 *
 * Postgres gets one row per entry; files get JSONL. Both are append-only and
 * never rewritten, so a crash costs at most the last entry.
 */
export async function appendLog<T>(stream: string, rows: T[]): Promise<number> {
  if (rows.length === 0) return 0;

  if (backend() === "postgres") {
    const { getPool } = await import("@/lib/db/client");
    const client = await getPool().connect();
    try {
      const values: unknown[] = [];
      const placeholders = rows.map((r, i) => {
        values.push(stream, JSON.stringify(r));
        return `($${i * 2 + 1}, $${i * 2 + 2})`;
      });
      await client.query(
        `INSERT INTO app_log (stream, entry) VALUES ${placeholders.join(", ")}`,
        values,
      );
    } finally {
      client.release();
    }
    return rows.length;
  }

  const file = filePathFor(`log_${stream}`).replace(/\.json$/, ".jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  return rows.length;
}

/** Read an append log, oldest first. */
export async function readLog<T>(stream: string, limit?: number): Promise<T[]> {
  if (backend() === "postgres") {
    const { query } = await import("@/lib/db/client");
    const rows = await query<{ entry: unknown }>(
      limit
        ? `SELECT entry FROM (
             SELECT entry, id FROM app_log WHERE stream = $1 ORDER BY id DESC LIMIT $2
           ) t ORDER BY id ASC`
        : "SELECT entry FROM app_log WHERE stream = $1 ORDER BY id ASC",
      limit ? [stream, limit] : [stream],
    );
    return rows.map((r) => r.entry as T);
  }

  const file = filePathFor(`log_${stream}`).replace(/\.json$/, ".jsonl");
  try {
    const raw = await fs.readFile(file, "utf-8");
    const all = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          // A torn final line from a crash must not make the log unreadable.
          return null;
        }
      })
      .filter((x): x is T => x !== null);
    return limit ? all.slice(-limit) : all;
  } catch {
    return [];
  }
}

export async function clearLog(stream: string): Promise<void> {
  if (backend() === "postgres") {
    const { query } = await import("@/lib/db/client");
    await query("DELETE FROM app_log WHERE stream = $1", [stream]);
    return;
  }
  const file = filePathFor(`log_${stream}`).replace(/\.json$/, ".jsonl");
  await fs.rm(file, { force: true });
}

/* --------------------------------------------------------------------- keys */

export const KEYS = {
  config: "engine_config",
  halt: "halt_state",
  vault: "credentials",
} as const;

export const LOGS = {
  configAudit: "config_audit",
  haltAudit: "halt_audit",
  fills: "paper_fills",
  orders: "paper_orders",
  funding: "paper_funding",
} as const;
