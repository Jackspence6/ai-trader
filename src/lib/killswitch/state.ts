/**
 * Halt state.
 *
 * DESIGN.md §6: "The kill switch must work when everything else is broken."
 * That requirement drives every choice in this file.
 *
 * Halt state lives in its own small file, read and written by code with no
 * dependencies beyond `node:fs`. It is deliberately NOT part of the engine
 * config, even though it started there. Config is validated, clamped,
 * cross-field-checked and audit-diffed — all reasonable for thresholds, and all
 * of it code that can throw. If a config parse fails, the honest answer to "are
 * we halted?" must still be available, and the answer must fail toward halted.
 *
 * So: a tiny file, a tiny reader, and a parse failure means halted.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { appendLog, backend, KEYS, LOGS, readJson, readLog, writeJson } from "@/lib/store/kv";

export type HaltSource = "dashboard" | "cli" | "http" | "auto" | "unknown";

export type HaltState = {
  halted: boolean;
  /** When the current halt began. Null when running. */
  since: number | null;
  reason: string | null;
  source: HaltSource | null;
  /** Who tripped it, where known. */
  actor: string | null;
};

export const RUNNING: HaltState = {
  halted: false,
  since: null,
  reason: null,
  source: null,
  actor: null,
};

/**
 * File path for the SYNCHRONOUS reader only.
 *
 * `readHaltSync` exists for the standalone kill-switch endpoint, which runs on
 * a machine we control and must answer without an event-loop turn. It is
 * file-only by necessity — there is no synchronous Postgres client — and that
 * is fine, because the process that needs it is the one that also owns the
 * files. Every other reader uses the async path and follows DATABASE_URL.
 */
function statePath(): string {
  return path.join(
    process.env.STATE_DIR ?? path.join(process.cwd(), ".data"),
    "halt_state.json",
  );
}

/**
 * Read halt state, failing toward halted.
 *
 * A missing file means "never halted", which is the correct reading of a fresh
 * install. But a file that exists and cannot be parsed means something is
 * wrong with our own state, and the safe interpretation of "I don't know" is
 * "stop" — the cost of a false halt is a missed opportunity, the cost of a
 * false all-clear is unbounded.
 */
export async function readHalt(): Promise<HaltState> {
  try {
    const parsed = await readJson<Partial<HaltState>>(KEYS.halt);
    // Absent means never halted, which is the correct reading of a fresh
    // install. Only a store that is present and broken fails safe.
    if (parsed === null) return { ...RUNNING };

    return {
      halted: Boolean(parsed.halted),
      since: typeof parsed.since === "number" ? parsed.since : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      source: (parsed.source as HaltSource) ?? null,
      actor: typeof parsed.actor === "string" ? parsed.actor : null,
    };
  } catch (e) {
    // Unreadable state — corrupt file, or a database we cannot reach. Either
    // way we do not know whether it is safe to trade, and the only acceptable
    // answer to that is "stop". A false halt costs an opportunity; a false
    // all-clear is unbounded.
    return {
      halted: true,
      since: null,
      reason: `Halt state could not be read (${
        e instanceof Error ? e.message : String(e)
      }). Failing safe: treating the system as halted.`,
      source: "auto",
      actor: null,
    };
  }
}

/**
 * Synchronous read, for callers that cannot await.
 *
 * The kill switch's own HTTP endpoint uses this so it can answer without an
 * event-loop turn, which matters when the reason you are asking is that
 * something else is wedged.
 */
export function readHaltSync(): HaltState {
  try {
    const raw = readFileSync(statePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<HaltState>;
    return {
      halted: Boolean(parsed.halted),
      since: typeof parsed.since === "number" ? parsed.since : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      source: (parsed.source as HaltSource) ?? null,
      actor: typeof parsed.actor === "string" ? parsed.actor : null,
    };
  } catch (e) {
    // Distinguish "no file" (never halted) from "bad file" (fail safe).
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ...RUNNING };
    return {
      halted: true,
      since: null,
      reason: "Halt state unreadable. Failing safe: treating the system as halted.",
      source: "auto",
      actor: null,
    };
  }
}

export type HaltEvent = {
  ts: number;
  /**
   * `sweep` is a separate action from `halt` on purpose. The halt is recorded
   * the instant it is set; the venue outcome lands seconds later. Two entries
   * show that ordering — and show it plainly when the sweep never arrived
   * because the venues were unreachable.
   */
  action: "halt" | "resume" | "sweep";
  reason: string | null;
  source: HaltSource;
  actor: string | null;
  /** Outcome of the venue sweep, when one ran. */
  sweep?: unknown;
};

async function appendAudit(event: HaltEvent): Promise<void> {
  try {
    await appendLog(LOGS.haltAudit, [event]);
  } catch {
    // An audit write failure must never prevent a halt. Losing the log entry
    // is bad; failing to stop trading because we could not log is worse.
  }
}

/**
 * Halt.
 *
 * Idempotent: halting an already-halted system succeeds and leaves the original
 * `since` and reason intact, so a second press does not erase why it first
 * stopped. The audit log still records the repeat.
 */
export async function halt(
  reason: string,
  source: HaltSource = "unknown",
  actor: string | null = null,
): Promise<HaltState> {
  const current = await readHalt();

  const next: HaltState = current.halted
    ? current
    : { halted: true, since: Date.now(), reason, source, actor };

  await write(next);
  await appendAudit({ ts: Date.now(), action: "halt", reason, source, actor });
  return next;
}

/** Record the outcome of a venue sweep against the halt that triggered it. */
export async function recordSweep(
  sweep: unknown,
  summary: string,
  source: HaltSource = "unknown",
  actor: string | null = null,
): Promise<void> {
  await appendAudit({ ts: Date.now(), action: "sweep", reason: summary, source, actor, sweep });
}

/**
 * Resume.
 *
 * Deliberately requires a reason. Restarting a system that stopped itself is a
 * decision someone should have to articulate, and the audit log is where the
 * next person finds out why it was thought safe.
 */
export async function resume(
  reason: string,
  source: HaltSource = "unknown",
  actor: string | null = null,
): Promise<HaltState> {
  await write({ ...RUNNING });
  await appendAudit({ ts: Date.now(), action: "resume", reason, source, actor });
  return { ...RUNNING };
}

async function write(state: HaltState): Promise<void> {
  // The KV layer writes atomically on files (temp + rename) and
  // transactionally on Postgres, so a crash mid-write cannot leave truncated
  // state — which, given the fail-safe-to-halted read above, would otherwise
  // wedge the system.
  await writeJson(KEYS.halt, state);
}

/** Recent halt/resume events, newest first. */
export async function readAudit(limit = 50): Promise<HaltEvent[]> {
  try {
    return (await readLog<HaltEvent>(LOGS.haltAudit, limit)).reverse();
  } catch {
    return [];
  }
}

/** Which backend halt state is stored in, for display. */
export { backend as haltBackend };
