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

import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";

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

function statePath(): string {
  return process.env.HALT_PATH ?? path.join(process.cwd(), ".data", "halt.json");
}

function auditPath(): string {
  return (
    process.env.HALT_AUDIT_PATH ?? path.join(process.cwd(), ".data", "halt-audit.jsonl")
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
  let raw: string;
  try {
    raw = await fs.readFile(statePath(), "utf-8");
  } catch {
    return { ...RUNNING };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<HaltState>;
    return {
      halted: Boolean(parsed.halted),
      since: typeof parsed.since === "number" ? parsed.since : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      source: (parsed.source as HaltSource) ?? null,
      actor: typeof parsed.actor === "string" ? parsed.actor : null,
    };
  } catch {
    return {
      halted: true,
      since: null,
      reason:
        "Halt state file is corrupt and could not be parsed. Failing safe: treating the system as halted.",
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
    await fs.mkdir(path.dirname(auditPath()), { recursive: true });
    await fs.appendFile(auditPath(), JSON.stringify(event) + "\n", "utf-8");
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
  const file = statePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write to a temp file and rename. Rename is atomic on POSIX, so a crash
  // mid-write cannot leave a truncated halt file — which, given the
  // fail-safe-to-halted parse above, would otherwise wedge the system.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

/** Recent halt/resume events, newest first. */
export async function readAudit(limit = 50): Promise<HaltEvent[]> {
  try {
    const raw = await fs.readFile(auditPath(), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as HaltEvent;
        } catch {
          return null;
        }
      })
      .filter((x): x is HaltEvent => x !== null)
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}
