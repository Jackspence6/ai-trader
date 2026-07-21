/**
 * Recorder liveness.
 *
 * File modification time cannot distinguish "running" from "stopped four
 * minutes ago", and a dashboard that reports a dead recorder as healthy is
 * worse than one that reports nothing — you would not go and restart it.
 *
 * So the recorder writes a heartbeat file containing its PID, and liveness is
 * checked by signalling that PID with signal 0, which tests for the process's
 * existence without touching it. A stale file from a killed process is
 * detected and reported as stale rather than believed.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const HEARTBEAT_PATH = path.join(process.cwd(), ".data", "recorder.json");

export type Heartbeat = {
  pid: number;
  startedAt: number;
  beatAt: number;
  cycles: { quotes: number; scan: number; funding: number };
  rows: { quotes: number; scan: number; funding: number };
  errors: number;
  lastError: string | null;
};

export async function writeHeartbeat(hb: Heartbeat): Promise<void> {
  await fs.mkdir(path.dirname(HEARTBEAT_PATH), { recursive: true });
  await fs.writeFile(HEARTBEAT_PATH, JSON.stringify(hb, null, 2), "utf-8");
}

export async function clearHeartbeat(): Promise<void> {
  try {
    await fs.unlink(HEARTBEAT_PATH);
  } catch {
    // Already gone — nothing to do.
  }
}

export type LivenessState =
  | { state: "running"; heartbeat: Heartbeat; ageSeconds: number }
  | { state: "stale"; heartbeat: Heartbeat; ageSeconds: number; reason: string }
  | { state: "stopped" };

/**
 * Is the recorder actually alive?
 *
 * `process.kill(pid, 0)` performs the permission and existence check without
 * delivering a signal — the standard way to ask "is this PID alive?".
 *
 * A live PID whose heartbeat has gone quiet is reported as *stale*, not
 * running: the process existing is not the same as the loop making progress,
 * and a wedged recorder is exactly the failure this is meant to catch.
 */
export async function readLiveness(maxBeatAgeSeconds = 180): Promise<LivenessState> {
  let hb: Heartbeat;
  try {
    hb = JSON.parse(await fs.readFile(HEARTBEAT_PATH, "utf-8")) as Heartbeat;
  } catch {
    return { state: "stopped" };
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - hb.beatAt) / 1000));

  let alive = false;
  try {
    process.kill(hb.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }

  if (!alive) {
    return {
      state: "stale",
      heartbeat: hb,
      ageSeconds,
      reason: `Process ${hb.pid} is gone — the recorder died without shutting down cleanly`,
    };
  }

  if (ageSeconds > maxBeatAgeSeconds) {
    return {
      state: "stale",
      heartbeat: hb,
      ageSeconds,
      reason: `Process ${hb.pid} is alive but has not recorded for ${ageSeconds}s`,
    };
  }

  return { state: "running", heartbeat: hb, ageSeconds };
}
