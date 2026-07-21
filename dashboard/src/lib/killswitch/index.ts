/**
 * The kill switch.
 *
 * Ordering inside `trip()` is the important part: **state first, then venues.**
 *
 * Setting the halt flag before sweeping means that even if the venue calls
 * hang, time out, or the process dies mid-sweep, every component that consults
 * halt state already refuses to trade. Doing it the other way round leaves a
 * window where we are cancelling orders while the strategies are still free to
 * place new ones, which is a race that resolves badly.
 */

import { UNIVERSE } from "@/lib/market/types";
import { cancelAll, registerDeadMan, type SweepResult } from "./actions";
import { halt, recordSweep, resume, type HaltSource, type HaltState } from "./state";

/** Symbols we cancel across. Derived from the trading universe. */
export function killSymbols(): string[] {
  return UNIVERSE.map((a) => `${a}USDT`);
}

export type TripResult = {
  state: HaltState;
  sweep: SweepResult;
};

/**
 * Halt everything and cancel resting orders.
 *
 * Never throws. A kill switch that can fail to run is not one, so every error
 * is captured into the sweep report and the halt itself always sticks.
 */
export async function trip(
  reason: string,
  source: HaltSource = "unknown",
  actor: string | null = null,
): Promise<TripResult> {
  // 1. Stop the system logically. This is the step that must not fail, so it
  //    happens before anything that touches the network.
  const state = await halt(reason, source, actor);

  // 2. Then clean up at the venues.
  let sweep: SweepResult;
  try {
    sweep = await cancelAll(killSymbols());
  } catch (e) {
    sweep = {
      ts: Date.now(),
      attempted: 0,
      succeeded: 0,
      failed: 1,
      venues: [],
      noCredentials: false,
    };
    console.error("[killswitch] sweep failed:", e);
  }

  // Recorded as its own event rather than a second halt, so the log reads
  // "halted at T, venues confirmed at T+2s" — and shows plainly when that
  // second line never arrived.
  await recordSweep(
    sweep,
    sweep.noCredentials
      ? "No enabled credentials — nothing to cancel"
      : `${sweep.succeeded}/${sweep.attempted} venues swept`,
    source,
    actor,
  );

  return { state, sweep };
}

/** Clear the halt. Requires a reason, which is recorded. */
export async function clear(
  reason: string,
  source: HaltSource = "unknown",
  actor: string | null = null,
): Promise<HaltState> {
  return resume(reason, source, actor);
}

/**
 * Re-arm exchange-side dead-man timers.
 *
 * Meant to be called on a heartbeat by the engine once an order path exists.
 * Until then it is exercised manually so the path is known to work rather than
 * discovered to be broken at the worst moment.
 */
export async function armDeadMan(countdownMs = 120_000) {
  return registerDeadMan(countdownMs, killSymbols());
}

export { readHalt, readAudit } from "./state";
export type { HaltState, HaltEvent, HaltSource } from "./state";
export type { SweepResult, VenueSweepResult } from "./actions";
