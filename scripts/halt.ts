#!/usr/bin/env tsx
/**
 * Kill switch, from the command line.
 *
 *   pnpm halt "reason"            halt and cancel resting orders
 *   pnpm halt:status              current state and recent history
 *   pnpm halt:resume "reason"     clear the halt
 *   pnpm halt:deadman [seconds]   arm exchange-side dead-man timers
 *
 * The third access path, alongside the dashboard and the standalone HTTP
 * endpoint. Three paths is not redundancy for its own sake: the dashboard needs
 * a browser, the HTTP endpoint needs its process running, and this needs only a
 * shell on the box.
 */

import { armDeadMan, clear, readAudit, readHalt, trip } from "@/lib/killswitch";

const cmd = process.argv[2] ?? "status";
const arg = process.argv.slice(3).join(" ").trim();

function fmt(ts: number) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function main() {
  switch (cmd) {
    case "halt": {
      const reason = arg || "Manual halt via CLI";
      console.log(`\n  Halting: ${reason}\n`);
      const { state, sweep } = await trip(reason, "cli", process.env.USER ?? null);

      console.log(`  State       HALTED since ${fmt(state.since ?? Date.now())}`);
      if (sweep.noCredentials) {
        console.log(`  Venues      no enabled credentials — nothing to cancel`);
      } else {
        console.log(`  Venues      ${sweep.succeeded}/${sweep.attempted} swept`);
        for (const v of sweep.venues) {
          console.log(`    ${v.ok ? "ok  " : "FAIL"} ${v.venue.padEnd(12)} ${v.detail}`);
        }
      }
      console.log("");
      break;
    }

    case "resume": {
      if (!arg) {
        console.error(
          "\n  A reason is required.  pnpm halt:resume \"why it is safe to restart\"\n",
        );
        process.exit(1);
      }
      await clear(arg, "cli", process.env.USER ?? null);
      console.log(`\n  Resumed: ${arg}\n`);
      break;
    }

    case "deadman": {
      const seconds = Number(arg) || 120;
      console.log(`\n  Arming exchange-side dead-man timers (${seconds}s)…\n`);
      const results = await armDeadMan(seconds * 1000);
      if (results.length === 0) {
        console.log("  No enabled credentials.\n");
        break;
      }
      for (const r of results) {
        console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.venue.padEnd(12)} ${r.detail}`);
      }
      console.log(
        `\n  These must be re-armed on a heartbeat well inside the window.\n` +
          `  A timer set once and never refreshed cancels your orders mid-session.\n`,
      );
      break;
    }

    case "status": {
      const [state, audit] = await Promise.all([readHalt(), readAudit(10)]);
      console.log("");
      if (state.halted) {
        console.log(`  HALTED`);
        console.log(`  Since       ${state.since ? fmt(state.since) : "unknown"}`);
        console.log(`  Reason      ${state.reason ?? "—"}`);
        console.log(`  Source      ${state.source ?? "—"}${state.actor ? ` (${state.actor})` : ""}`);
      } else {
        console.log(`  Running — not halted.`);
      }

      if (audit.length > 0) {
        console.log(`\n  Recent history`);
        for (const e of audit) {
          console.log(
            `    ${fmt(e.ts)}  ${e.action.toUpperCase().padEnd(6)} ${e.source.padEnd(9)} ${e.reason ?? ""}`,
          );
        }
      }
      console.log("");
      break;
    }

    default:
      console.error(`\n  Unknown command "${cmd}". Use: halt | resume | status | deadman\n`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
