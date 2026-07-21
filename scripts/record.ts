#!/usr/bin/env tsx
/**
 * Standalone recorder entry point.
 *
 *   pnpm record            # run with defaults
 *   pnpm record --quiet    # no per-cycle logging
 *
 * Runs independently of the dashboard so closing the browser, or restarting
 * the dev server, does not interrupt data collection.
 *
 * Shuts down cleanly on SIGINT/SIGTERM. Because writes are append-only and
 * flushed per batch, an unclean kill loses at most the current cycle.
 */

import { createRecorder } from "@/lib/recorder/recorder";

const quiet = process.argv.includes("--quiet");

const recorder = createRecorder({ verbose: !quiet });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down.`);
  await recorder.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// An unhandled rejection must not silently kill the recorder — log it and
// keep going, since the loop's own error handling covers the expected cases.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

recorder.start().catch((e) => {
  console.error("Recorder failed to start:", e);
  process.exit(1);
});
