/**
 * Live risk-limit utilisation.
 *
 * Turns the risk limits from something the UI merely *displays* into something
 * it *measures against*: current fund drawdown and day P&L versus their limits,
 * and the same per sleeve, computed from the stored high-water marks and the
 * live NAV. This is the read side of the enforcement in `engine/risk.ts`.
 */

import { readConfig } from "@/lib/engine/store";
import { RISK_STATE_KEY } from "@/lib/engine/pass";
import { readJson } from "@/lib/store/kv";
import { readHalt } from "@/lib/killswitch";
import { getFundState, currentPrices } from "@/lib/fund/nav";
import { readFills, readFundingPayments } from "@/lib/oms/store";
import { buildPositions, markPositions, sleevePnl } from "@/lib/portfolio/positions";
import { sleeveById } from "@/lib/portfolio/sleeves";
import type { RiskState } from "@/lib/engine/risk";

export async function GET() {
  const prices = await currentPrices();
  const [config, state, halt, fund, fills, funding] = await Promise.all([
    readConfig(),
    readJson<RiskState>(RISK_STATE_KEY),
    readHalt(),
    getFundState(prices),
    readFills(),
    readFundingPayments(),
  ]);

  const nav = fund.navUsd;
  const fundHwm = Math.max(state?.fundHwmUsd ?? nav, nav);
  const dayStart = state?.dayStartUsd ?? nav;
  const fundDrawdown = fundHwm > 0 ? Math.max(0, (fundHwm - nav) / fundHwm) : 0;
  const fundDayLoss = dayStart > 0 ? Math.max(0, (dayStart - nav) / dayStart) : 0;

  const sleevePnls = sleevePnl(markPositions(buildPositions(fills, funding), prices));

  const sleeves = config.sleeves
    .filter((s) => s.enabled && s.allocatedUsd > 0)
    .map((s) => {
      const def = sleeveById(s.sleeveId);
      const pnl = sleevePnls.find((p) => p.sleeveId === s.sleeveId);
      const equity = s.allocatedUsd + (pnl?.totalUsd ?? 0);
      const hwm = Math.max(state?.sleeveHwmUsd?.[s.sleeveId] ?? equity, equity);
      const drawdown = hwm > 0 ? Math.max(0, (hwm - equity) / hwm) : 0;
      return {
        id: s.sleeveId,
        name: def?.name ?? s.sleeveId,
        assetClass: def?.assetClass ?? "crypto",
        equityUsd: equity,
        hwmUsd: hwm,
        drawdownPct: drawdown,
        limitPct: def?.limits.maxDrawdownPct ?? 0,
        halted: s.halted,
      };
    });

  return Response.json(
    {
      halted: halt.halted,
      haltReason: halt.reason,
      haltSource: halt.source,
      fund: {
        navUsd: nav,
        hwmUsd: fundHwm,
        drawdownPct: fundDrawdown,
        drawdownLimitPct: config.maxDrawdownPct,
        dayStartUsd: dayStart,
        dayLossPct: fundDayLoss,
        dayLossLimitPct: config.dailyLossLimitPct,
      },
      sleeves,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
