/** Live USD-based FX rates for the display-currency switcher. */

import { fetchFxRates } from "@/lib/market/fx";

export async function GET() {
  const fx = await fetchFxRates();
  return Response.json(fx, { headers: { "cache-control": "no-store" } });
}
