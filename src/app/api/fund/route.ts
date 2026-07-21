/**
 * Fund state and the capital ledger.
 *
 * GET  — NAV, P&L, capital event history
 * POST — record a deposit or withdrawal
 *
 * NAV is derived here, never supplied by the caller. A client that could set
 * NAV could set it wrong, and every position size and tier gate downstream
 * would inherit the mistake.
 */

import { recordCapitalEvent, resetLedger, type CapitalNature } from "@/lib/fund/ledger";
import { getFundState, tradingPnl } from "@/lib/fund/nav";
import { FUND } from "@/lib/fund/fund";

export async function GET() {
  const state = await getFundState();

  return Response.json(
    {
      fund: FUND,
      nav: {
        navUsd: state.navUsd,
        netContributedUsd: state.netContributedUsd,
        depositedUsd: state.depositedUsd,
        withdrawnUsd: state.withdrawnUsd,
        performanceIndex: state.performanceIndex,
        twrPct: state.twrPct,
        returnOnCapitalPct: state.returnOnCapitalPct,
        funded: state.funded,
        nature: state.nature,
        mixed: state.mixed,
      },
      pnl: state.pnl,
      // Newest first — the ledger is read as "what happened lately".
      events: [...state.events].reverse(),
      openPositions: state.openPositions,
      unpriced: state.unpriced,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let body: {
    action?: string;
    type?: string;
    amountUsd?: number;
    nature?: string;
    note?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action === "reset") {
    await resetLedger();
    return Response.json({ reset: true }, { headers: { "cache-control": "no-store" } });
  }

  const type = body.type === "withdrawal" ? "withdrawal" : "deposit";
  const nature: CapitalNature = body.nature === "real" ? "real" : "simulated";

  // P&L is passed in so units are priced against the CURRENT NAV per unit,
  // including unrealised gains. Pricing against contributed capital alone would
  // let a late deposit buy units cheaply and dilute earlier gains.
  const { pnl } = await tradingPnl();

  const result = await recordCapitalEvent({
    type,
    amountUsd: Number(body.amountUsd),
    nature,
    note: body.note,
    pnl,
  });

  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });

  return Response.json(
    { event: result.event, nav: result.nav },
    { headers: { "cache-control": "no-store" } },
  );
}
