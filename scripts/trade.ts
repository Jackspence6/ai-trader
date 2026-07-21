#!/usr/bin/env tsx
/**
 * The trading loop.
 *
 *   pnpm trade                run continuously
 *   pnpm trade --once         a single pass, then exit
 *   pnpm trade --interval 60  seconds between passes (default 300)
 *
 * This is the always-on process. It scans live markets, runs every candidate
 * through the risk gate, executes what survives against the paper venue, and
 * records the outcome — the same loop a live engine runs, with a venue that
 * cannot reach an exchange.
 *
 * **Where this runs.** Serverless has no process to hold a loop, so the
 * deployment uses a scheduled invocation instead — `/api/cron/trade`, same
 * pass, driven by Vercel Cron. That works on plans with minute-granularity
 * crons; the Hobby tier is limited to roughly one invocation a day, which is
 * not a trading cadence. This script is the alternative: run it on any box
 * that stays up. Both share state through Postgres, so whichever is running,
 * there is one book.
 *
 * Running both at once is harmless but pointless — they would compete for the
 * same sleeve capacity and each pass would mostly find the other had taken it.
 *
 * The pass itself lives in `lib/engine/pass.ts` so this and the deployment's
 * cron endpoint run identical code. Two implementations of "the thing that
 * decides trades" is how a system ends up behaving differently depending on
 * which machine happened to be awake.
 *
 * Failure policy matches the recorder: a pass that throws is logged and
 * skipped. The loop never exits on a venue or network error, because those are
 * exactly the conditions worth having a record of.
 */

import { runTradingPass } from "@/lib/engine/pass";

const args = process.argv.slice(2);
const once = args.includes("--once");
const intervalIdx = args.indexOf("--interval");
const intervalSec = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) || 300 : 300;

function stamp() {
  return new Date().toISOString();
}

async function safePass() {
  try {
    const { record, summary } = await runTradingPass();
    console.log(`[${stamp()}] ${summary}`);
    for (const a of record.accuracy) {
      console.log(
        `             ${a.strategy}: predicted ${a.meanPredictedCostBps.toFixed(2)}bp · ` +
          `realised ${a.meanRealisedCostBps.toFixed(2)}bp · ` +
          `error ${a.meanErrorBps >= 0 ? "+" : ""}${a.meanErrorBps.toFixed(2)}bp`,
      );
    }
  } catch (e) {
    console.error(`[${stamp()}] pass failed:`, e instanceof Error ? e.message : e);
  }
}

async function main() {
  console.log(
    `Trading loop starting — paper venue, ${once ? "single pass" : `every ${intervalSec}s`}`,
  );
  console.log("Nothing here can reach an exchange.\n");

  await safePass();
  if (once) return;

  const timer = setInterval(safePass, intervalSec * 1000);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} — stopping. Positions and the ledger are unchanged.`);
      clearInterval(timer);
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error("Trading loop failed to start:", e);
  process.exit(1);
});
