/**
 * Real account balances from every enabled credential.
 *
 * Read-only. There is no order path in this codebase yet, and this route
 * exists so NAV can stop being a number typed into a box.
 *
 * Assets we cannot price are reported by name rather than valued at zero.
 * Silently treating an unpriced holding as worthless understates NAV, and NAV
 * is the input to the capital ladder and every limit derived from it — an
 * understated NAV quietly tightens everything, which is safer than the
 * alternative but still wrong, and wrong silently is the part that matters.
 */

import { enabledCredentials, withCredential } from "@/lib/vault/store";
import { fetchBalances, markToUsd, VenueAuthError, type Balance } from "@/lib/vault/venues";
import { fetchSnapshot } from "@/lib/market/venues";

export async function GET() {
  const creds = await enabledCredentials();

  if (creds.length === 0) {
    return Response.json(
      {
        accounts: [],
        totalUsd: 0,
        unpriced: [],
        errors: [],
        note: "No enabled credentials. Add one on the Exchanges screen; NAV stays manual until then.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // One price map for every venue, from the public feed we already poll.
  const snapshot = await fetchSnapshot();
  const prices = new Map<string, number>();
  for (const q of snapshot.quotes) {
    if (q.kind === "spot" && q.last > 0 && !prices.has(q.asset)) {
      prices.set(q.asset, q.last);
    }
  }

  const results = await Promise.allSettled(
    creds.map(async (c) => {
      const balances = await withCredential(c.id, (s) =>
        fetchBalances(c.venue, s.apiKey, s.apiSecret),
      );
      const { totalUsd, unpriced } = markToUsd(balances, prices);
      return { credentialId: c.id, venue: c.venue, label: c.label, balances, totalUsd, unpriced };
    }),
  );

  const accounts: {
    credentialId: string;
    venue: string;
    label: string;
    balances: Balance[];
    totalUsd: number | null;
    unpriced: string[];
  }[] = [];
  const errors: { credentialId: string; message: string }[] = [];

  results.forEach((r, i) => {
    if (r.status === "fulfilled") accounts.push(r.value);
    else {
      const e = r.reason;
      errors.push({
        credentialId: creds[i].id,
        message:
          e instanceof VenueAuthError
            ? `${e.venue}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  });

  const unpriced = [...new Set(accounts.flatMap((a) => a.unpriced))];

  return Response.json(
    {
      accounts,
      // Summing across accounts is only meaningful when every one succeeded;
      // a partial total looks like a NAV drop rather than a fetch failure.
      totalUsd: errors.length === 0 ? accounts.reduce((a, x) => a + (x.totalUsd ?? 0), 0) : null,
      unpriced,
      errors,
      note: null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
