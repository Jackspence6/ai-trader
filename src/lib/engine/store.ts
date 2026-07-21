/**
 * Configuration persistence.
 *
 * Stored through the shared KV layer, so it lives in Postgres when
 * `DATABASE_URL` is set and in a local file otherwise. That is what lets the
 * same code run on a serverless host, where the filesystem is read-only, and on
 * a laptop with no database.
 *
 * Every write is audit-logged with a timestamp and a diff. Config changes are
 * the highest-consequence action available in the UI short of the kill switch,
 * and "who loosened the edge threshold?" needs an answer.
 */

import { appendLog, KEYS, LOGS, readJson, readLog, writeJson } from "@/lib/store/kv";
import {
  DEFAULT_CONFIG,
  sanitiseConfig,
  type EngineConfig,
} from "./config";

export type AuditEntry = {
  ts: number;
  changes: { field: string; from: unknown; to: unknown }[];
  adjustments: string[];
};

/**
 * Read the stored config, falling back to defaults.
 *
 * A corrupt or missing file yields defaults rather than an error: the dashboard
 * must always render, and defaults are the conservative position anyway.
 */
export async function readConfig(): Promise<EngineConfig> {
  try {
    const stored = await readJson<unknown>(KEYS.config);
    if (stored === null) return { ...DEFAULT_CONFIG };
    return sanitiseConfig(stored).config;
  } catch {
    // Defaults are the conservative position, and the dashboard must always
    // render. A config we cannot read is not a reason to show nothing.
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(
  input: unknown,
): Promise<{ config: EngineConfig; adjustments: string[] }> {
  const previous = await readConfig();
  const { config, adjustments } = sanitiseConfig(input);

  const changes = (Object.keys(config) as (keyof EngineConfig)[])
    .filter((k) => config[k] !== previous[k])
    .map((k) => ({ field: k, from: previous[k], to: config[k] }));

  await writeJson(KEYS.config, config);

  if (changes.length > 0 || adjustments.length > 0) {
    const entry: AuditEntry = { ts: Date.now(), changes, adjustments };
    await appendLog(LOGS.configAudit, [entry]);
  }

  return { config, adjustments };
}

/** Most recent audit entries, newest first. */
export async function readAudit(limit = 50): Promise<AuditEntry[]> {
  try {
    return (await readLog<AuditEntry>(LOGS.configAudit, limit)).reverse();
  } catch {
    return [];
  }
}
