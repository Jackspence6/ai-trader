/**
 * Trading-loop health and recent pass history.
 *
 * Liveness is derived from the durable pass log rather than a process check —
 * the loop may be the local script or the deployment cron, and either way the
 * record it leaves is the truth about whether trading decisions are being
 * made. See lib/engine/health.ts for the failure modes this surfaces.
 */

import { loopHealth } from "@/lib/engine/health";
import { TRADE_LOG, type TradePassRecord } from "@/lib/engine/pass";
import { readLog } from "@/lib/store/kv";

const WINDOW = 60;

export async function GET() {
  const records = await readLog<TradePassRecord>(TRADE_LOG, WINDOW);
  const health = loopHealth(records, Date.now());

  return Response.json(
    {
      health,
      // Newest first for display; the health window and this list share bounds.
      recent: [...records]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 20)
        .map((r) => ({
          ts: r.ts,
          scored: r.scored,
          executed: r.executed,
          closed: r.closed ?? 0,
          openPositions: r.openPositions,
          navAfter: r.navAfter,
          rejections: r.rejections,
          exits: r.exits ?? {},
          skipped: r.skipped,
        })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
