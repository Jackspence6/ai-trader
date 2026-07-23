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

/**
 * The operator's seed: R30,000 total, split so both books can run their
 * charter allocations — crypto carries Conservative-core plus the Aggressive
 * trend sleeve, forex carries FX carry plus the Experimental revalidation.
 */
const ZAR_SPLIT = { crypto: 19_000, forex: 11_000 } as const;

/**
 * Charter spread (GOVERNANCE.md), as shares of each account's seeded balance.
 * The remainder in each account is the margin buffer. Every funded sleeve
 * stays under its portfolio's cap: Conservative ≈63% of NAV (cap 85%),
 * Aggressive ≈19% (cap 25%), Experimental ≈9% (cap 10%).
 */
const SPREAD = {
  core: { account: "crypto", share: 0.62 },
  systematic: { account: "crypto", share: 0.31 },
  "fx-carry": { account: "forex", share: 0.66 },
  "fx-trend": { account: "forex", share: 0.24 },
} as const;

async function main() {
  const commit = process.argv.includes("--commit");

  if (!process.env.DATABASE_URL) {
    console.log("No DATABASE_URL — this targets the LOCAL store, not Neon.\n");
  }

  const rates = await getRateTable();
  const usdPerZar = usdPerUnit(rates, "ZAR");
  const zarPerUsd = usdPerZar > 0 ? 1 / usdPerZar : 0;
  const usdBy = {
    crypto: ZAR_SPLIT.crypto * usdPerZar,
    forex: ZAR_SPLIT.forex * usdPerZar,
  };

  console.log(`Rate:          ${rates.source} · 1 USD = R${zarPerUsd.toFixed(4)}`);
  console.log(`Seed:          crypto R${ZAR_SPLIT.crypto.toLocaleString()} → $${usdBy.crypto.toFixed(2)} · forex R${ZAR_SPLIT.forex.toLocaleString()} → $${usdBy.forex.toFixed(2)}`);
  console.log(`Total:         R${(ZAR_SPLIT.crypto + ZAR_SPLIT.forex).toLocaleString()} → $${(usdBy.crypto + usdBy.forex).toFixed(2)}`);
  for (const [sleeve, def] of Object.entries(SPREAD)) {
    console.log(`Allocate:      ${sleeve} $${(usdBy[def.account] * def.share).toFixed(0)} (${def.account})`);
  }

  if (!commit) {
    console.log("\nDry run. Re-run with --commit.");
    return;
  }

  console.log("\nWiping ledger, paper book, accrual clock and pass history…");
  await Promise.all([
    resetLedger(),
    resetPaperBook(),
    deleteKey("fx_carry_last_accrual"),
    // High-water marks belong to the OLD equity; keeping them would read the
    // reset itself as a catastrophic drawdown and halt everything at once.
    deleteKey("risk_state"),
    clearLog(TRADE_LOG),
  ]);

  for (const account of ["crypto", "forex"] as const) {
    const r = await recordCapitalEvent({
      account,
      type: "deposit",
      amount: ZAR_SPLIT[account],
      currency: "ZAR",
      usdPerUnit: usdPerZar,
      nature: "simulated",
      note: `Fresh start — R${ZAR_SPLIT[account].toLocaleString()} at ${rates.asOf}`,
    });
    if (!r.ok) {
      console.error(`  ${account}: FAILED — ${r.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ${account}: +$${r.event.amountUsd.toFixed(2)} · balance $${r.nav.navUsd.toFixed(2)}`);
  }

  // The charter spread: every portfolio funded, every cap respected.
  const fund = await getFundState();
  const config = await readConfig();
  const sleeves = defaultAllocations().map((a) => {
    const def = SPREAD[a.sleeveId as keyof typeof SPREAD];
    if (!def) return { ...a, allocatedUsd: 0, enabled: false };
    return { ...a, allocatedUsd: Math.round(usdBy[def.account] * def.share), enabled: true };
  });
  await writeConfig(
    { ...config, navUsd: fund.navUsd, sleeves },
    "Fresh start: R30,000 operator seed spread per the charter — Conservative (core + fx-carry), Aggressive (systematic H1), Experimental (fx-trend live revalidation, tuition capped)",
  );

  const after = await readCapitalEvents();
  console.log(`\nDone. NAV $${fund.navUsd.toFixed(2)} · ${after.length} capital events · sleeves allocated.`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
