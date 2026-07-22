/**
 * Fund state and the capital ledger.
 *
 * GET  — NAV, P&L, per-account balances, capital history, and a live rate table
 * POST — record a deposit or withdrawal into one account
 *
 * NAV is derived here, never supplied by the caller. A client that could set
 * NAV could set it wrong, and every position size and tier gate downstream
 * would inherit the mistake. The same goes for the FX rate on a ZAR deposit —
 * it is fetched server-side, never taken from the request, so a client cannot
 * mint dollars by claiming a favourable rate.
 */

import {
  recordCapitalEvent,
  resetLedger,
  FUND_ACCOUNTS,
  type CapitalNature,
  type FundAccount,
} from "@/lib/fund/ledger";
import { getFundState, tradingPnl } from "@/lib/fund/nav";
import { getRateTable, inDisplayCurrencies, usdPerUnit } from "@/lib/market/convert";
import { FUND } from "@/lib/fund/fund";

function navView(s: {
  navUsd: number;
  netContributedUsd: number;
  depositedUsd: number;
  withdrawnUsd: number;
  performanceIndex: number;
  twrPct: number;
  returnOnCapitalPct: number | null;
  funded: boolean;
  nature: string;
  mixed: boolean;
}) {
  return {
    navUsd: s.navUsd,
    netContributedUsd: s.netContributedUsd,
    depositedUsd: s.depositedUsd,
    withdrawnUsd: s.withdrawnUsd,
    performanceIndex: s.performanceIndex,
    twrPct: s.twrPct,
    returnOnCapitalPct: s.returnOnCapitalPct,
    funded: s.funded,
    nature: s.nature,
    mixed: s.mixed,
  };
}

export async function GET() {
  const [state, rates] = await Promise.all([getFundState(), getRateTable()]);

  return Response.json(
    {
      fund: FUND,
      nav: {
        ...navView(state),
        // The headline NAV in every display currency, so the UI never has to
        // convert client-side or show a missing figure.
        display: inDisplayCurrencies(rates, state.navUsd),
      },
      pnl: state.pnl,
      accounts: state.accounts.map((a) => ({
        account: a.account,
        label: FUND_ACCOUNTS.find((f) => f.id === a.account)?.label ?? a.account,
        note: FUND_ACCOUNTS.find((f) => f.id === a.account)?.note ?? "",
        nav: navView(a),
        display: inDisplayCurrencies(rates, a.navUsd),
        pnl: a.pnl,
        openPositions: a.openPositions,
        unpriced: a.unpriced,
      })),
      rates: {
        source: rates.source,
        asOf: rates.asOf,
        usdPer: rates.usdPer,
        // Convenience: how many ZAR to one USD, the number the operator thinks in.
        zarPerUsd: rates.usdPer.ZAR ? 1 / rates.usdPer.ZAR : null,
      },
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
    account?: string;
    type?: string;
    amount?: number;
    amountUsd?: number;
    currency?: string;
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

  const account = body.account as FundAccount;
  if (!FUND_ACCOUNTS.some((a) => a.id === account)) {
    return Response.json(
      { error: `Choose an account: ${FUND_ACCOUNTS.map((a) => a.id).join(" or ")}` },
      { status: 400 },
    );
  }

  const type = body.type === "withdrawal" ? "withdrawal" : "deposit";
  const nature: CapitalNature = body.nature === "real" ? "real" : "simulated";
  const currency = (body.currency ?? "USD").toUpperCase();
  // Back-compat: an `amountUsd`-only body still works and means USD.
  const amount = Number(body.amount ?? body.amountUsd);

  // The conversion rate is fetched server-side. A ZAR deposit is converted at
  // the live rate at this instant; USD needs no rate.
  let usdPerUnitRate: number | undefined;
  if (currency !== "USD") {
    const rates = await getRateTable();
    usdPerUnitRate = usdPerUnit(rates, currency);
    if (!usdPerUnitRate) {
      return Response.json(
        { error: `No conversion rate available for ${currency}` },
        { status: 400 },
      );
    }
  }

  // P&L for THIS account is passed in so units are priced against the account's
  // current NAV per unit, including unrealised gains. Pricing against
  // contributed capital alone would let a late deposit buy units cheaply and
  // dilute earlier gains.
  const { byAccount } = await tradingPnl();

  const result = await recordCapitalEvent({
    account,
    type,
    amount,
    currency,
    usdPerUnit: usdPerUnitRate,
    nature,
    note: body.note,
    pnl: byAccount[account].pnl,
  });

  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });

  return Response.json(
    { event: result.event, nav: result.nav },
    { headers: { "cache-control": "no-store" } },
  );
}
