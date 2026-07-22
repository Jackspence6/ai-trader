#!/usr/bin/env tsx
/**
 * Seed the capital ledger with the initial test stake.
 *
 *   tsx --env-file=.env.neon scripts/seed-ledger.ts          # dry run, prints the plan
 *   tsx --env-file=.env.neon scripts/seed-ledger.ts --commit # reset to zero and record
 *
 * The fund starts at zero, then takes one ZAR deposit into each account. The
 * rand amount is converted at the **live** rate the instant it is recorded and
 * stored as USD — the same path the Treasury form uses, so this is a real
 * capital event, not a hand-set balance.
 *
 * Nature is `simulated`: the platform paper-trades against live market data with
 * no venue linked, so this is a simulated stake, honestly labelled. That is a
 * different thing from a fake balance — the balance is derived from these real
 * recorded events and nothing else.
 */

import { recordCapitalEvent, resetLedger, readCapitalEvents } from "@/lib/fund/ledger";
import { getRateTable, usdPerUnit } from "@/lib/market/convert";

const ZAR_PER_ACCOUNT = 5000;

async function main() {
  const commit = process.argv.includes("--commit");

  if (!process.env.DATABASE_URL) {
    console.log(
      "No DATABASE_URL set — this would seed the LOCAL file store, not Neon.\n" +
        "Run with: tsx --env-file=.env.neon scripts/seed-ledger.ts --commit",
    );
  }

  const rates = await getRateTable();
  const usdPerZar = usdPerUnit(rates, "ZAR");
  const usdPerAccount = ZAR_PER_ACCOUNT * usdPerZar;
  const zarPerUsd = usdPerZar > 0 ? 1 / usdPerZar : 0;

  console.log(`Rate source:   ${rates.source} (${rates.asOf})`);
  console.log(`Live rate:     1 USD = R${zarPerUsd.toFixed(4)}`);
  console.log(
    `Per account:   R${ZAR_PER_ACCOUNT.toLocaleString()} → $${usdPerAccount.toFixed(2)}`,
  );
  console.log(`Both accounts: $${(usdPerAccount * 2).toFixed(2)} total\n`);

  const existing = await readCapitalEvents();
  console.log(`Existing capital events: ${existing.length}`);

  if (!commit) {
    console.log("\nDry run. Re-run with --commit to reset to zero and record the seed.");
    return;
  }

  console.log("\nResetting ledger to zero…");
  await resetLedger();

  for (const account of ["crypto", "forex"] as const) {
    const r = await recordCapitalEvent({
      account,
      type: "deposit",
      amount: ZAR_PER_ACCOUNT,
      currency: "ZAR",
      usdPerUnit: usdPerZar,
      nature: "simulated",
      note: `Initial test stake — R${ZAR_PER_ACCOUNT.toLocaleString()} at ${rates.asOf}`,
    });
    if (!r.ok) {
      console.error(`  ${account}: FAILED — ${r.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `  ${account}: +$${r.event.amountUsd.toFixed(2)} (R${ZAR_PER_ACCOUNT.toLocaleString()}) · balance $${r.nav.navUsd.toFixed(2)}`,
    );
  }

  const after = await readCapitalEvents();
  console.log(`\nDone. Ledger now holds ${after.length} events.`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
