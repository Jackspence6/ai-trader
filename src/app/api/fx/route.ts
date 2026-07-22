/**
 * Live USD-based FX rates for the display-currency switcher.
 *
 * Backed by the resilient converter: a live fix when the provider answers, the
 * last-known fix when it does not, and a labelled reference seed only on a
 * brand-new deployment. A conversion is therefore never "unavailable".
 */

import { getRateTable, toFxRates } from "@/lib/market/convert";

export async function GET() {
  const table = await getRateTable();
  return Response.json(toFxRates(table), { headers: { "cache-control": "no-store" } });
}
