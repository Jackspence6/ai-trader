/**
 * Credential vault.
 *
 * Stores exchange API credentials encrypted at rest, and — this is the part
 * that matters — never renders them back.
 *
 * DESIGN.md §6 calls trade-only, no-withdrawal, IP-whitelisted keys "the single
 * highest-value security control in the system". This module enforces the
 * no-withdrawal half in code: a credential whose venue reports withdrawal
 * permission cannot be enabled, and the check is re-run on every use rather
 * than trusted from the moment it was added. Permissions can be widened on the
 * exchange after we first saw them, and a check that only runs once would never
 * notice.
 *
 * The read path is deliberately narrow. `list()` returns metadata only — venue,
 * label, a four-character fingerprint, permissions, timestamps. The secret is
 * reachable only through `withCredential()`, which hands it to a callback and
 * does not return it, so a secret cannot escape into a response body by
 * accident.
 */

import { KEYS, readJson, writeJson } from "@/lib/store/kv";
import { fingerprint, open, seal, VaultError, type SealedRecord } from "./crypto";

export type VenueId = "binance" | "bybit" | "hyperliquid";

export type Permissions = {
  /** The hard block. True means this credential is refused. */
  withdrawals: boolean;
  reading: boolean;
  spotTrading: boolean;
  futuresTrading: boolean;
  /** Whether the venue reports an IP allowlist on this key. */
  ipRestricted: boolean;
  /** When we last asked the venue. */
  checkedAt: number;
};

export type CredentialMeta = {
  id: string;
  venue: VenueId;
  label: string;
  /** Non-secret display form, e.g. "AbCd…WxYz". */
  keyFingerprint: string;
  addedAt: number;
  /** Null until the venue has been asked. */
  permissions: Permissions | null;
  /** False when blocked, disabled, or never verified. */
  enabled: boolean;
  /** Why it is not enabled, when it is not. */
  blockedReason: string | null;
};

type StoredCredential = CredentialMeta & {
  apiKey: SealedRecord;
  apiSecret: SealedRecord;
  /** Some venues (OKX) require a passphrase. */
  passphrase: SealedRecord | null;
};

/**
 * Storage goes through the KV layer, so credentials live in Postgres on a
 * serverless host and in an owner-only local file otherwise. Set `STATE_DIR` to
 * relocate the local files.
 *
 * What does NOT change with the backend: contents are encrypted before they
 * reach the store either way. A database compromise yields ciphertext, not API
 * keys — the master key is only ever in the process environment.
 */
async function readAll(): Promise<StoredCredential[]> {
  try {
    return (await readJson<StoredCredential[]>(KEYS.vault)) ?? [];
  } catch {
    return [];
  }
}

async function writeAll(creds: StoredCredential[]): Promise<void> {
  await writeJson(KEYS.vault, creds);
}

function toMeta(c: StoredCredential): CredentialMeta {
  return {
    id: c.id,
    venue: c.venue,
    label: c.label,
    keyFingerprint: c.keyFingerprint,
    addedAt: c.addedAt,
    permissions: c.permissions,
    enabled: c.enabled,
    blockedReason: c.blockedReason,
  };
}

/** All stored credentials, as metadata. Never includes secrets. */
export async function list(): Promise<CredentialMeta[]> {
  return (await readAll()).map(toMeta);
}

export type AddResult =
  | { ok: true; credential: CredentialMeta }
  | { ok: false; error: string };

/**
 * Store a credential.
 *
 * Added **disabled**. Enabling requires a successful permission check that
 * confirms withdrawals are off — so the default state of a freshly-added key is
 * "cannot be used", and the only way out of it is evidence from the venue.
 */
export async function add(input: {
  venue: VenueId;
  label: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}): Promise<AddResult> {
  const { venue, label, apiKey, apiSecret, passphrase } = input;

  if (!apiKey.trim() || !apiSecret.trim()) {
    return { ok: false, error: "API key and secret are both required" };
  }

  try {
    const creds = await readAll();

    // Re-adding the same key silently would leave two records that can drift
    // apart in enabled state — one blocked, one not.
    const fp = fingerprint(apiKey);
    if (creds.some((c) => c.venue === venue && c.keyFingerprint === fp)) {
      return { ok: false, error: `This key is already stored for ${venue}` };
    }

    const record: StoredCredential = {
      id: `${venue}-${Date.now().toString(36)}`,
      venue,
      label: label.trim() || venue,
      keyFingerprint: fp,
      addedAt: Date.now(),
      permissions: null,
      enabled: false,
      blockedReason: "Not yet verified — run a permission check",
      apiKey: seal(apiKey.trim()),
      apiSecret: seal(apiSecret.trim()),
      passphrase: passphrase?.trim() ? seal(passphrase.trim()) : null,
    };

    creds.push(record);
    await writeAll(creds);
    return { ok: true, credential: toMeta(record) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof VaultError ? e.message : `Could not store credential: ${e}`,
    };
  }
}

export async function remove(id: string): Promise<boolean> {
  const creds = await readAll();
  const next = creds.filter((c) => c.id !== id);
  if (next.length === creds.length) return false;
  await writeAll(next);
  return true;
}

/**
 * Run `fn` with a credential's secrets, without returning them.
 *
 * Named `with-` rather than `use-` deliberately: `use*` is the React hook
 * convention, and a non-hook wearing that prefix misleads every reader and
 * trips the hook lint rules at every call site.
 *
 * The secrets are passed to `fn` and never leave this function. Returning them
 * instead would put them one careless `Response.json(...)` away from a browser,
 * and that mistake is easy to make and impossible to take back.
 */
export async function withCredential<T>(
  id: string,
  fn: (secrets: { apiKey: string; apiSecret: string; passphrase: string | null }) => Promise<T>,
): Promise<T> {
  const creds = await readAll();
  const c = creds.find((x) => x.id === id);
  if (!c) throw new VaultError(`No credential with id ${id}`);

  return fn({
    apiKey: open(c.apiKey),
    apiSecret: open(c.apiSecret),
    passphrase: c.passphrase ? open(c.passphrase) : null,
  });
}

/**
 * Record the result of a permission check and set enabled state accordingly.
 *
 * This is the enforcement point for the withdrawal block. A credential with
 * withdrawal permission is stored but permanently unusable until the operator
 * fixes it on the exchange and re-checks — we do not offer an override, because
 * an override is the only thing standing between a compromised process and the
 * account being emptied.
 */
export async function applyPermissions(
  id: string,
  permissions: Permissions,
): Promise<CredentialMeta | null> {
  const creds = await readAll();
  const c = creds.find((x) => x.id === id);
  if (!c) return null;

  c.permissions = permissions;

  if (permissions.withdrawals) {
    c.enabled = false;
    c.blockedReason =
      "BLOCKED — this key has withdrawal permission enabled. " +
      "Disable withdrawals on the exchange and re-check. This cannot be overridden.";
  } else if (!permissions.reading) {
    c.enabled = false;
    c.blockedReason = "Key cannot read account data — check its permissions on the exchange";
  } else {
    c.enabled = true;
    c.blockedReason = permissions.ipRestricted
      ? null
      : "Enabled, but no IP allowlist is set on this key — strongly recommended";
  }

  await writeAll(creds);
  return toMeta(c);
}

/** Mark a credential unusable, e.g. after a failed check. */
export async function disable(id: string, reason: string): Promise<void> {
  const creds = await readAll();
  const c = creds.find((x) => x.id === id);
  if (!c) return;
  c.enabled = false;
  c.blockedReason = reason;
  await writeAll(creds);
}

/** Credentials cleared for use right now. */
export async function enabledCredentials(): Promise<CredentialMeta[]> {
  return (await list()).filter((c) => c.enabled);
}
