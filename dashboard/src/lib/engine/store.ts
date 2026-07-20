/**
 * Configuration persistence.
 *
 * A flat JSON file on disk. This is deliberately the simplest thing that works:
 * DESIGN.md puts config in Postgres alongside the engine, and this module is
 * the dashboard-only stand-in until that engine exists. Keeping it behind a
 * narrow read/write interface means swapping it for the real store later
 * touches this file and nothing else.
 *
 * Every write is audit-logged with a timestamp and a diff. Config changes are
 * the highest-consequence action available in the UI short of the kill switch,
 * and "who loosened the edge threshold?" needs an answer.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  sanitiseConfig,
  type EngineConfig,
} from "./config";

const DATA_DIR = path.join(process.cwd(), ".data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const AUDIT_PATH = path.join(DATA_DIR, "config-audit.jsonl");

export type AuditEntry = {
  ts: number;
  changes: { field: string; from: unknown; to: unknown }[];
  adjustments: string[];
};

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/**
 * Read the stored config, falling back to defaults.
 *
 * A corrupt or missing file yields defaults rather than an error: the dashboard
 * must always render, and defaults are the conservative position anyway.
 */
export async function readConfig(): Promise<EngineConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return sanitiseConfig(JSON.parse(raw)).config;
  } catch {
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

  await ensureDir();
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");

  if (changes.length > 0 || adjustments.length > 0) {
    const entry: AuditEntry = { ts: Date.now(), changes, adjustments };
    await fs.appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n", "utf-8");
  }

  return { config, adjustments };
}

/** Most recent audit entries, newest first. */
export async function readAudit(limit = 50): Promise<AuditEntry[]> {
  try {
    const raw = await fs.readFile(AUDIT_PATH, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry)
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}
