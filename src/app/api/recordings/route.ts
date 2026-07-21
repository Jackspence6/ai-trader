/**
 * Recorder status — what has been captured, and whether it is still capturing.
 *
 * Liveness comes from the heartbeat PID check rather than file timestamps, so
 * a dead recorder reports as dead instead of merely quiet.
 */

import { readLiveness } from "@/lib/recorder/heartbeat";
import { recordingsRoot, summarise } from "@/lib/recorder/store";
import { backendDescription } from "@/lib/store/kv";

export async function GET() {
  const [summary, liveness] = await Promise.all([summarise(14), readLiveness()]);

  return Response.json(
    { root: recordingsRoot(), summary, liveness, stateBackend: backendDescription() },
    { headers: { "cache-control": "no-store" } },
  );
}
