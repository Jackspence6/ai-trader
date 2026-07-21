/**
 * Credential management.
 *
 * GET    list credentials as metadata — never secrets
 * POST   add a credential (stored disabled) or verify one
 * DELETE remove a credential
 *
 * The response shape is deliberately narrow. Every path returns `CredentialMeta`
 * and nothing else, so there is no route by which a secret can reach a browser
 * even if a future edit is careless.
 */

import { hasMasterKey } from "@/lib/vault/crypto";
import {
  add,
  applyPermissions,
  disable,
  list,
  remove,
  withCredential,
  type VenueId,
} from "@/lib/vault/store";
import { checkPermissions, VenueAuthError } from "@/lib/vault/venues";

const VENUES: VenueId[] = ["binance", "bybit", "hyperliquid"];

export async function GET() {
  return Response.json(
    { vaultReady: hasMasterKey(), credentials: await list() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!hasMasterKey()) {
    return Response.json(
      {
        error:
          "VAULT_KEY is not set. Generate one with `openssl rand -base64 32` and put it in dashboard/.env.local.",
      },
      { status: 400 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = String(body.action ?? "add");

  /* ---------------------------------------------------------------- verify */
  //
  // Runs the venue's own permission endpoint and applies the result. This is
  // the only path that can enable a credential, and it re-runs on demand rather
  // than trusting a check from when the key was added — permissions can be
  // widened on the exchange afterwards.

  if (action === "verify") {
    const id = String(body.id ?? "");
    const creds = await list();
    const meta = creds.find((c) => c.id === id);
    if (!meta) return Response.json({ error: "No such credential" }, { status: 404 });

    try {
      const permissions = await withCredential(id, (s) =>
        checkPermissions(meta.venue, s.apiKey, s.apiSecret),
      );
      const updated = await applyPermissions(id, permissions);
      return Response.json({ credential: updated }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      // A failed check disables the credential. Leaving it enabled on an
      // unverifiable key is exactly the state this whole module exists to
      // prevent.
      const message =
        e instanceof VenueAuthError
          ? `${e.venue}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      await disable(id, `Verification failed — ${message}`);
      const updated = (await list()).find((c) => c.id === id) ?? null;
      return Response.json({ credential: updated, error: message }, { status: 200 });
    }
  }

  /* ------------------------------------------------------------------- add */

  const venue = String(body.venue ?? "") as VenueId;
  if (!VENUES.includes(venue)) {
    return Response.json({ error: `Unsupported venue: ${venue}` }, { status: 400 });
  }

  const result = await add({
    venue,
    label: String(body.label ?? ""),
    apiKey: String(body.apiKey ?? ""),
    apiSecret: String(body.apiSecret ?? ""),
    passphrase: body.passphrase ? String(body.passphrase) : undefined,
  });

  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  return Response.json(
    { credential: result.credential },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const removed = await remove(id);
  return Response.json({ removed }, { headers: { "cache-control": "no-store" } });
}
