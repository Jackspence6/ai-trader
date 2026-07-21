#!/usr/bin/env tsx
/**
 * Report what has been recorded so far.
 *
 *   pnpm record:stats
 *
 * Deliberately blunt about gaps: a day with a small line count is more
 * informative than a day missing from the list entirely, so every day between
 * the first and last is shown even when empty.
 */

import { listDays, recordingsRoot, statsForDay, summarise } from "@/lib/recorder/store";
import { readLiveness } from "@/lib/recorder/heartbeat";

function mb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Every UTC day from `from` to `to` inclusive, so gaps are visible. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(to + "T00:00:00Z");
  let t = Date.parse(from + "T00:00:00Z");
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

async function main() {
  const days = await listDays();

  console.log(`\nRecordings at ${recordingsRoot()}\n`);

  if (days.length === 0) {
    console.log("  Nothing recorded yet. Start with:  pnpm record\n");
    return;
  }

  const span = daysBetween(days[0], days[days.length - 1]);
  const present = new Set(days);

  console.log(
    `  ${"DAY".padEnd(12)}${"QUOTES".padStart(10)}${"SCAN".padStart(10)}${"FUNDING".padStart(10)}${"SIZE".padStart(12)}`,
  );
  console.log(`  ${"-".repeat(54)}`);

  for (const day of span) {
    if (!present.has(day)) {
      console.log(`  ${day.padEnd(12)}${"— no data —".padStart(42)}`);
      continue;
    }
    const s = await statsForDay(day);
    const get = (name: string) =>
      String(s.streams.find((x) => x.stream === name)?.lines ?? 0);
    const compressed = s.streams.some((x) => x.compressed) ? " gz" : "";
    console.log(
      `  ${day.padEnd(12)}${get("quotes").padStart(10)}${get("scan").padStart(10)}${get("funding").padStart(10)}${(mb(s.totalBytes) + compressed).padStart(12)}`,
    );
  }

  const sum = await summarise(400);
  console.log(`  ${"-".repeat(54)}`);
  console.log(
    `  ${String(sum.days + " days").padEnd(12)}${String(sum.totalLines).padStart(30)} rows${mb(sum.totalBytes).padStart(12)}`,
  );

  const missing = span.length - days.length;
  if (missing > 0) {
    console.log(
      `\n  ${missing} day${missing === 1 ? "" : "s"} with no data in the recorded span.`,
    );
  }

  // Liveness comes from the heartbeat PID check, not from file timestamps —
  // a file written four minutes ago says nothing about whether the process
  // still exists.
  const live = await readLiveness();
  if (live.state === "running") {
    const upMin = Math.round((Date.now() - live.heartbeat.startedAt) / 60000);
    console.log(
      `\n  Running — pid ${live.heartbeat.pid}, up ${upMin}m, last beat ${live.ageSeconds}s ago, ${live.heartbeat.errors} errors.\n`,
    );
  } else if (live.state === "stale") {
    console.log(`\n  STALE — ${live.reason}\n  Restart with:  pnpm record\n`);
  } else {
    console.log(`\n  Not running. Start it with:  pnpm record\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
