/**
 * Which money is at risk, and why.
 *
 * Two independent signals, deliberately not collapsed into one:
 *
 *   mode    what the *engine* would do with an order right now, decided by the
 *           execution seam in oms/venues/resolve;
 *   nature  what the *ledger* says has actually been deposited.
 *
 * They can disagree, and when they do that is the interesting case rather than
 * an error to smooth over. Paper mode with real capital on the books means
 * money is sitting idle; live mode with simulated capital means the next
 * deposit goes straight to a real venue. Both are worth seeing before they
 * become surprises.
 */

import { NextResponse } from "next/server";
import { describeExecutionMode } from "@/lib/oms/venues/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Resolved without a credential on purpose: this route answers "what is this
  // process configured to do", and reading the vault to answer it would make a
  // read-only status endpoint touch secrets.
  const { mode, reason } = describeExecutionMode();
  return NextResponse.json(
    {
      mode,
      reason,
      mainnetEnabled: process.env.ALLOW_MAINNET_TRADING === "true",
      requested: (process.env.MERIDIAN_EXECUTION ?? "paper").toLowerCase(),
      time: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
