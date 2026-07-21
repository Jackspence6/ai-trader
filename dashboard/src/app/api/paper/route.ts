/**
 * Run one paper-trading pass.
 *
 * POST executes; GET reports what the book looks like. Nothing here can reach
 * an exchange — the venue is `SimulatedVenue`, and no live `Venue`
 * implementation exists for it to be swapped with.
 */

import { fetchSnapshot, fetchBinanceFundingHistory } from "@/lib/market/venues";
import { UNIVERSE } from "@/lib/market/types";
import { scan } from "@/lib/engine/scanner";
import { readConfig } from "@/lib/engine/store";
import { readHalt } from "@/lib/killswitch";
import { daysHeldAbove } from "@/lib/db/nav";
import { tierForNav } from "@/lib/calc/tiers";
import { SimulatedVenue, booksFromQuotes } from "@/lib/oms/simulated";
import { edgeAccuracy, runPaperPass } from "@/lib/oms/paper";
import {
  readFills,
  readFundingPayments,
  recordFills,
  recordOrders,
  resetPaperBook,
} from "@/lib/oms/store";

export async function GET() {
  const [fills, funding] = await Promise.all([readFills(), readFundingPayments()]);
  return Response.json(
    { mode: "paper", isLive: false, fills: fills.length, funding: funding.length },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let body: { action?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body means "run a pass", which is the common case.
  }

  if (body.action === "reset") {
    await resetPaperBook();
    return Response.json({ reset: true }, { headers: { "cache-control": "no-store" } });
  }

  const [snapshot, config, halt] = await Promise.all([
    fetchSnapshot(),
    readConfig(),
    readHalt(),
  ]);

  let daysHeldAboveThreshold = 0;
  try {
    daysHeldAboveThreshold = await daysHeldAbove(tierForNav(config.navUsd).minNavUsd);
  } catch {
    daysHeldAboveThreshold = 0;
  }

  const histories = await Promise.allSettled(
    UNIVERSE.map((a) => fetchBinanceFundingHistory(a, config.fundingRegimeWindow)),
  );
  const fundingHistory: Record<string, number[]> = {};
  histories.forEach((h, i) => {
    if (h.status === "fulfilled") {
      fundingHistory[`Binance:${UNIVERSE[i]}`] = h.value.map((r) => r.apr);
    }
  });

  const opportunities = scan({
    config,
    snapshot,
    fundingHistory,
    daysHeldAboveThreshold,
    halted: halt.halted,
  });

  const venue = new SimulatedVenue();
  venue.setBooks(booksFromQuotes(snapshot.quotes));

  const prices = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.last > 0 && !prices.has(q.asset)) prices.set(q.asset, q.last);
  }

  const existingFills = await readFills();

  const result = await runPaperPass({
    config,
    opportunities,
    venue,
    prices,
    halted: halt.halted,
    dataAgeSeconds: (Date.now() - snapshot.asOf) / 1000,
    daysHeldAboveThreshold,
    existingFills,
    funding: await readFundingPayments(),
  });

  // Persist only what actually executed.
  const orders = result.decisions.flatMap((d) => (d.executed ? d.orders : []));
  await Promise.all([recordOrders(orders), recordFills(result.fills)]);

  return Response.json(
    {
      mode: "paper",
      isLive: false,
      ...result,
      accuracy: edgeAccuracy(result.decisions),
      candidates: opportunities.length,
      liveEligible: opportunities.filter((o) => o.wouldTake).length,
      scored: opportunities.length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
