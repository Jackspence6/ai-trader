/**
 * Portfolio state — the single answer to "what money is where, and how is
 * each portfolio doing?" (GOVERNANCE.md §1, §5).
 *
 * Aggregates config allocations, live position P&L, capital consumption and
 * the risk engine's portfolio high-water marks into one per-portfolio view:
 * allocated / deployed / available, the P&L split, drawdown against the
 * charter limit, cap usage against the charter share, member sleeves with
 * their own numbers, and halt status. The Portfolios screen renders this
 * verbatim — the API is the truth, the page is the paint.
 */

import { PORTFOLIOS } from "@/lib/portfolio/portfolios";
import { sleeveById } from "@/lib/portfolio/sleeves";
import {
  buildPositions,
  capitalConsumedUsd,
  markPositions,
  sleevePnl,
} from "@/lib/portfolio/positions";
import { readFills, readFundingPayments } from "@/lib/oms/store";
import { readConfig } from "@/lib/engine/store";
import { RISK_STATE_KEY } from "@/lib/engine/pass";
import type { RiskState } from "@/lib/engine/risk";
import { readJson } from "@/lib/store/kv";
import { fetchSnapshot } from "@/lib/market/venues";
import { fetchFxQuotes } from "@/lib/market/forex";
import { fxPrices } from "@/lib/market/fxbook";
import { getNavUsd } from "@/lib/fund/nav";

export async function GET() {
  const [snapshot, fxQuotes, config, fills, funding, riskState] = await Promise.all([
    fetchSnapshot(),
    fetchFxQuotes().catch(() => []),
    readConfig(),
    readFills(),
    readFundingPayments(),
    readJson<RiskState>(RISK_STATE_KEY).catch(() => null),
  ]);

  const prices = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.last > 0 && !prices.has(q.asset)) prices.set(q.asset, q.last);
  }
  for (const [symbol, rate] of fxPrices(fxQuotes)) prices.set(symbol, rate);

  const navUsd = await getNavUsd(prices);
  const marked = markPositions(buildPositions(fills, funding), prices).filter(
    (p) => p.qty !== 0,
  );
  const pnls = sleevePnl(markPositions(buildPositions(fills, funding), prices));

  const leverageFor = (id: string) =>
    Math.min(config.perpLeverage, sleeveById(id)?.limits.maxLeverage ?? config.perpLeverage);

  const portfolios = PORTFOLIOS.map((p) => {
    const memberAllocs = config.sleeves.filter((s) => p.sleeves.includes(s.sleeveId));
    const allocatedUsd = memberAllocs
      .filter((s) => s.enabled)
      .reduce((a, s) => a + Math.max(s.allocatedUsd, 0), 0);

    const members = memberAllocs.map((s) => {
      const def = sleeveById(s.sleeveId);
      const pnl = pnls.find((x) => x.sleeveId === s.sleeveId);
      const positions = marked.filter((m) => m.sleeveId === s.sleeveId);
      return {
        sleeveId: s.sleeveId,
        name: def?.name ?? s.sleeveId,
        strategies: def?.strategies ?? [],
        allocatedUsd: s.allocatedUsd,
        enabled: s.enabled,
        halted: s.halted,
        deployedUsd: capitalConsumedUsd(positions, leverageFor),
        openPositions: positions.length,
        pnl: {
          realisedUsd: pnl?.realisedUsd ?? 0,
          fundingUsd: pnl?.fundingUsd ?? 0,
          feesUsd: pnl?.feesUsd ?? 0,
          unrealisedUsd: pnl?.unrealisedUsd ?? null,
          totalUsd: pnl?.totalUsd ?? 0,
        },
      };
    });

    const deployedUsd = members.reduce((a, m) => a + m.deployedUsd, 0);
    const totalPnlUsd = members.reduce((a, m) => a + m.pnl.totalUsd, 0);
    const equityUsd = allocatedUsd + totalPnlUsd;
    const hwm = riskState?.portfolioHwmUsd?.[p.id] ?? equityUsd;
    const drawdownPct = hwm > 0 ? Math.max(0, (hwm - equityUsd) / hwm) : 0;

    return {
      id: p.id,
      name: p.name,
      objective: p.objective,
      maxShareOfNav: p.maxShareOfNav,
      maxDrawdownPct: p.maxDrawdownPct,
      allocatedUsd,
      deployedUsd,
      availableUsd: Math.max(allocatedUsd - deployedUsd, 0),
      equityUsd,
      capUsd: navUsd * p.maxShareOfNav,
      capUsedPct: navUsd > 0 ? allocatedUsd / (navUsd * p.maxShareOfNav) : 0,
      drawdownPct,
      anyHalted: members.some((m) => m.enabled && m.halted),
      pnl: {
        realisedUsd: members.reduce((a, m) => a + m.pnl.realisedUsd, 0),
        fundingUsd: members.reduce((a, m) => a + m.pnl.fundingUsd, 0),
        feesUsd: members.reduce((a, m) => a + m.pnl.feesUsd, 0),
        unrealisedUsd: members.reduce((a, m) => a + (m.pnl.unrealisedUsd ?? 0), 0),
        totalUsd: totalPnlUsd,
      },
      members,
    };
  });

  const allocatedTotal = portfolios.reduce((a, p) => a + p.allocatedUsd, 0);

  return Response.json(
    {
      navUsd,
      allocatedTotal,
      reserveUsd: Math.max(navUsd - allocatedTotal, 0),
      portfolios,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
