#!/usr/bin/env tsx
/**
 * Fresh start — wipe the book and re-seed both accounts from zero.
 *
 *   tsx --env-file=.env.neon scripts/fresh-start.ts           # print the plan
 *   tsx --env-file=.env.neon scripts/fresh-start.ts --commit  # do it
 *
 * This is the "start measuring the strategy for real" button. It clears every
 * derived record — capital events, fills, orders, funding, the carry-accrual
 * clock and the pass history — so nothing from earlier testing is left in the
 * numbers, then seeds each account with a real ZAR deposit converted at the live
 * rate, and allocates the two sleeves that actually run a live strategy.
 *
 * On "real": every price, funding rate, FX rate, cost and P&L is derived from
 * live market data — nothing is mocked. The capital is labelled `simulated`
 * because no money sits at a broker and fills are paper fills against the real
 * order book. That is the honest label for a paper account, and it is exactly
 * what makes the P&L a trustworthy test of whether the strategy works. It is
 * NOT "real money" — the platform cannot place a live order — so it is not
 * labelled as such.
 */

import { recordCapitalEvent, resetLedger, readCapitalEvents } from "@/lib/fund/ledger";
import { getRateTable, usdPerUnit } from "@/lib/market/convert";
import { resetPaperBook } from "@/lib/oms/store";
import { getFundState } from "@/lib/fund/nav";
import { readConfig, writeConfig } from "@/lib/engine/store";
import { defaultAllocations } from "@/lib/portfolio/sleeves";
import { clearLog, deleteKey } from "@/lib/store/kv";
import { TRADE_LOG } from "@/lib/engine/pass";

const ZAR_PER_ACCOUNT = 10_000;
/** Share of each account's balance to put to work; the rest is the margin buffer. */
const DEPLOY_SHARE = 0.66;

async function main() {
  const commit = process.argv.includes("--commit");

  if (!process.env.DATABASE_URL) {
    console.log("No DATABASE_URL — this targets the LOCAL store, not Neon.\n");
  }

  const rates = await getRateTable();
  const usdPerZar = usdPerUnit(rates, "ZAR");
  const usdPerAccount = ZAR_PER_ACCOUNT * usdPerZar;
  const zarPerUsd = usdPerZar > 0 ? 1 / usdPerZar : 0;

  console.log(`Rate:          ${rates.source} · 1 USD = R${zarPerUsd.toFixed(4)}`);
  console.log(`Per account:   R${ZAR_PER_ACCOUNT.toLocaleString()} → $${usdPerAccount.toFixed(2)}`);
  console.log(`Total seed:    $${(usdPerAccount * 2).toFixed(2)}`);

  const deployPerAccount = usdPerAccount * DEPLOY_SHARE;
  console.log(
    `Allocate:      core $${deployPerAccount.toFixed(0)} (crypto) · fx-carry $${deployPerAccount.toFixed(0)} (forex)`,
  );

  if (!commit) {
    console.log("\nDry run. Re-run with --commit.");
    return;
  }

  console.log("\nWiping ledger, paper book, accrual clock and pass history…");
  await Promise.all([
    resetLedger(),
    resetPaperBook(),
    deleteKey("fx_carry_last_accrual"),
    clearLog(TRADE_LOG),
  ]);

  for (const account of ["crypto", "forex"] as const) {
    const r = await recordCapitalEvent({
      account,
      type: "deposit",
      amount: ZAR_PER_ACCOUNT,
      currency: "ZAR",
      usdPerUnit: usdPerZar,
      nature: "simulated",
      note: `Fresh start — R${ZAR_PER_ACCOUNT.toLocaleString()} at ${rates.asOf}`,
    });
    if (!r.ok) {
      console.error(`  ${account}: FAILED — ${r.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ${account}: +$${r.event.amountUsd.toFixed(2)} · balance $${r.nav.navUsd.toFixed(2)}`);
  }

  // Allocate only the two sleeves that run a live strategy — core (crypto carry,
  // L1/L2) and fx-carry (forex F1). The other sleeves have no scanner yet, so
  // funding them would idle capital.
  const fund = await getFundState();
  const config = await readConfig();
  const sleeves = defaultAllocations().map((a) => {
    if (a.sleeveId === "core") return { ...a, allocatedUsd: deployPerAccount, enabled: true };
    if (a.sleeveId === "fx-carry") return { ...a, allocatedUsd: deployPerAccount, enabled: true };
    return { ...a, allocatedUsd: 0, enabled: false };
  });
  await writeConfig({ ...config, navUsd: fund.navUsd, sleeves });

  const after = await readCapitalEvents();
  console.log(`\nDone. NAV $${fund.navUsd.toFixed(2)} · ${after.length} capital events · sleeves allocated.`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
