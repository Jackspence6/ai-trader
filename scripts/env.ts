/**
 * Load `.env.local` for the command-line entry points.
 *
 * Next.js loads it automatically; nothing else does. So before this existed,
 * the console read the operator's configuration and the trading loop, the
 * recorder, the kill switch and the preflight check all ran on defaults — from
 * the same directory, on the same box, at the same time.
 *
 * The failure mode is quiet and bad. Set `DATABASE_URL` to a remote Postgres
 * and the console reads it while the loop writes to localhost; both look
 * healthy, and the disagreement only surfaces as missing history days later.
 *
 * Imported for its side effect, first, before anything that reads process.env.
 * Existing variables win: an explicit `DATABASE_URL=… pnpm trade` must override
 * the file, because that is the whole reason someone types it.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Later files do not override earlier ones, and neither overrides the real
// environment — same precedence Next.js uses, so the two agree.
for (const name of [".env.local", ".env"]) {
  const file = path.join(repo, name);
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    console.warn(`[env] could not read ${name}: ${(err as Error).message}`);
  }
}
