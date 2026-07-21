/**
 * Live cross-venue market snapshot plus FX rates.
 *
 * Uncached by default in Next 16, which is what we want — a cached price is a
 * lie with a timestamp on it. The client polls this and displays the data's age
 * so a stalled feed is visible rather than silently stale.
 */

import { fetchSnapshot } from "@/lib/market/venues";
import { fetchFxRates } from "@/lib/market/fx";

export async function GET() {
  const [snapshot, fx] = await Promise.all([fetchSnapshot(), fetchFxRates()]);

  return Response.json(
    { ...snapshot, fx },
    { headers: { "cache-control": "no-store" } },
  );
}
