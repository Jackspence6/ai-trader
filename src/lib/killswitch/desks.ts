/**
 * Propagating the halt to the Event Markets desk.
 *
 * The two desks run in different processes and different languages, so "stop"
 * has to reach both. The Asset Markets loop reads the halt state this package
 * owns; the Python events engine reads a row in its own schema, because it has
 * no way to see a Node process's state file.
 *
 * That split is the whole reason this module exists. Before it, the HALT button
 * stopped one desk and left the other scanning and alerting — the operator saw
 * a red HALTED chip and reasonably believed everything had stopped. A kill
 * switch that stops most of the system is worse than one that stops none of it,
 * because it is the one you trust.
 *
 * Failures here are reported, never thrown. The halt itself must stick even if
 * the database is unreachable, so this runs after the local state is already
 * written and its result is recorded alongside the venue sweep.
 */

import { hasDb, q } from "@/lib/events/db";

export type DeskHaltResult = {
  desk: "events";
  applied: boolean;
  /** Why it did not apply, when it did not. */
  note: string | null;
};

async function setEventsFlag(on: boolean): Promise<DeskHaltResult> {
  if (!hasDb()) {
    return {
      desk: "events",
      applied: false,
      note: "no database configured — the events engine is not running against this instance",
    };
  }
  try {
    await q(
      `INSERT INTO runtime_flags(key, value, updated_at, updated_by)
       VALUES ('kill_switch', $1::jsonb, now(), 'firm-halt')
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(on)],
    );
    return { desk: "events", applied: true, note: null };
  } catch (err) {
    return { desk: "events", applied: false, note: (err as Error).message };
  }
}

/** Stop the Event Markets desk. Scanning continues; alerting and any
 *  placement guidance stops, so the dry-run dataset stays whole. */
export function haltEvents(): Promise<DeskHaltResult> {
  return setEventsFlag(true);
}

/** Release the Event Markets desk. */
export function resumeEvents(): Promise<DeskHaltResult> {
  return setEventsFlag(false);
}

/** Whether the events desk currently believes it is halted. */
export async function readEventsHalt(): Promise<boolean | null> {
  if (!hasDb()) return null;
  try {
    const rows = await q<{ value: unknown }>(
      "SELECT value FROM runtime_flags WHERE key='kill_switch'",
    );
    if (rows.length === 0) return false;
    return rows[0].value === true || rows[0].value === "true";
  } catch {
    return null;
  }
}
