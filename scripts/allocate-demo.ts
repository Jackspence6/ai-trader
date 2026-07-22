#!/usr/bin/env tsx
/**
 * Fund the sleeves so both accounts actually trade.
 *
 *   tsx --env-file=.env.neon scripts/allocate-demo.ts           # print the plan
 *   tsx --env-file=.env.neon scripts/allocate-demo.ts --commit  # write it
 *
 * A seeded balance does not trade on its own — capital has to be allocated to a
 * sleeve, and by default only Core is even enabled, at $0. This sets a modest,
 * defensible allocation for the two seeded accounts:
 *
 *   - Crypto account → **Core** (market-neutral funding carry, the low-risk book)
 *   - Forex account  → **FX Carry** (the interest-differential book)
 *
 * Deliberately conservative and only two sleeves — this is a demonstration that
 * both accounts place paper trades, not a risk posture. Change it any time on
 * the Allocation screen.
 */

import { readConfig, writeConfig } from "@/lib/engine/store";
import { getFundState } from "@/lib/fund/nav";
import { defaultAllocations } from "@/lib/portfolio/sleeves";

const CORE_USD = 200; // crypto account
const FX_CARRY_USD = 200; // forex account

async function main() {
  const commit = process.argv.includes("--commit");

  if (!process.env.DATABASE_URL) {
    console.log("No DATABASE_URL — this would target the LOCAL store, not Neon.\n");
  }

  const fund = await getFundState();
  console.log(`Fund NAV: $${fund.navUsd.toFixed(2)}`);
  for (const a of fund.accounts) {
    console.log(`  ${a.account}: $${a.navUsd.toFixed(2)}`);
  }

  const config = await readConfig();
  const sleeves = defaultAllocations().map((a) => {
    if (a.sleeveId === "core") return { ...a, allocatedUsd: CORE_USD, enabled: true };
    if (a.sleeveId === "fx-carry") return { ...a, allocatedUsd: FX_CARRY_USD, enabled: true };
    return { ...a, allocatedUsd: 0, enabled: false };
  });

  console.log("\nPlanned allocation:");
  console.log(`  core     $${CORE_USD}  (crypto · market-neutral carry)`);
  console.log(`  fx-carry $${FX_CARRY_USD}  (forex · interest differential)`);
  console.log(`  total    $${CORE_USD + FX_CARRY_USD}  · reserve $${(fund.navUsd - CORE_USD - FX_CARRY_USD).toFixed(2)}`);

  if (!commit) {
    console.log("\nDry run. Re-run with --commit to write it.");
    return;
  }

  const { adjustments } = await writeConfig({ ...config, navUsd: fund.navUsd, sleeves });
  console.log("\nWritten.");
  if (adjustments.length) console.log("Adjustments: " + adjustments.join("; "));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
