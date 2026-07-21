"use client";

/**
 * Exchanges — credentials and real balances.
 *
 * The screen is built around one rule: a key that can withdraw is refused, and
 * there is no override. DESIGN.md §6 calls trade-only, no-withdrawal,
 * IP-whitelisted keys the single highest-value security control in the system,
 * and an override button would make it advisory.
 *
 * Secrets are write-only here. Fields are `type="password"`, never populated
 * from the server, and the API has no route that returns them — the dashboard
 * writes credentials but never renders them back.
 */

import { useCallback, useEffect, useState } from "react";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import type { CredentialMeta, VenueId } from "@/lib/vault/store";
import type { Balance } from "@/lib/vault/venues";
import { cx, Micro, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type CredentialsResponse = { vaultReady: boolean; credentials: CredentialMeta[] };

type BalancesResponse = {
  accounts: {
    credentialId: string;
    venue: string;
    label: string;
    balances: Balance[];
    totalUsd: number | null;
    unpriced: string[];
  }[];
  totalUsd: number | null;
  unpriced: string[];
  errors: { credentialId: string; message: string }[];
  note: string | null;
};

const VENUES: { id: VenueId; name: string; supported: boolean; note: string }[] = [
  { id: "binance", name: "Binance", supported: true, note: "Spot balances and API restrictions" },
  { id: "bybit", name: "Bybit", supported: true, note: "Unified account balances" },
  {
    id: "hyperliquid",
    name: "Hyperliquid",
    supported: false,
    note: "Uses API wallets, which cannot withdraw by construction. Not implemented yet.",
  },
];

export default function ExchangesPage() {
  const [creds, setCreds] = useState<CredentialMeta[]>([]);
  const [vaultReady, setVaultReady] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const balances = useLive<BalancesResponse>("/api/balances", 30_000);

  const refresh = useCallback(async () => {
    try {
      const d = (await fetch("/api/credentials").then((r) => r.json())) as CredentialsResponse;
      setCreds(d.credentials);
      setVaultReady(d.vaultReady);
    } catch {
      setNote("Could not load credentials");
    }
  }, []);

  useEffect(() => {
    // Loading server state on mount is the sanctioned use of an effect; the
    // state update happens after the await, which the rule cannot see through.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function verify(id: string) {
    setBusy(id);
    setNote(null);
    try {
      const r = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "verify", id }),
      });
      const d = (await r.json()) as { error?: string };
      if (d.error) setNote(d.error);
      await refresh();
      balances.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function del(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/credentials?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
      balances.refresh();
    } finally {
      setBusy(null);
    }
  }

  const enabled = creds.filter((c) => c.enabled);
  const blocked = creds.filter((c) => c.permissions?.withdrawals);

  return (
    <div className="space-y-3 p-3">
      {!vaultReady && <VaultKeyBanner />}
      {blocked.length > 0 && <WithdrawalBlockBanner count={blocked.length} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Panel>
          <Stat label="CREDENTIALS" sub={<span className="text-dim">stored</span>}>
            <span className="tnum text-[19px] text-ink">{creds.length}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="ENABLED" sub={<span className="text-dim">verified trade-only</span>}>
            <span className={cx("tnum text-[19px]", enabled.length ? "text-up" : "text-muted")}>
              {enabled.length}
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat
            label="ACCOUNT VALUE"
            sub={
              <span className="text-dim">
                {balances.data?.totalUsd === null && balances.data?.errors.length
                  ? "incomplete — a venue failed"
                  : "marked to USD"}
              </span>
            }
          >
            {balances.data?.totalUsd !== null && balances.data?.totalUsd !== undefined ? (
              <Money usd={balances.data.totalUsd} />
            ) : (
              <span className="text-[19px] text-dim">—</span>
            )}
          </Stat>
        </Panel>
        <Panel>
          <Stat label="ORDER PATH" sub={<span className="text-dim">by design</span>}>
            <span className="text-[15px] text-muted">READ-ONLY</span>
          </Stat>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel label="STORED CREDENTIALS" hint="SECRETS ARE WRITE-ONLY" flush>
          {creds.length === 0 ? (
            <div className="p-4 text-[12px] text-dim">
              No credentials stored. NAV stays manual until an account is linked.
            </div>
          ) : (
            <ul>
              {creds.map((c) => (
                <li key={c.id} className="border-b border-line/60 p-3 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot
                      state={
                        c.permissions?.withdrawals ? "bad" : c.enabled ? "ok" : "idle"
                      }
                      pulse={c.enabled}
                    />
                    <span className="text-[13px] text-ink">{c.label}</span>
                    <span className="micro text-dim">{c.venue}</span>
                    <span className="micro text-dim">{c.keyFingerprint}</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <button
                        onClick={() => verify(c.id)}
                        disabled={busy === c.id}
                        className="micro border border-line-bright px-2 py-1 text-muted transition-colors hover:text-ink disabled:opacity-40"
                      >
                        {busy === c.id ? "…" : "VERIFY"}
                      </button>
                      <button
                        onClick={() => del(c.id)}
                        disabled={busy === c.id}
                        className="micro border border-down/40 px-2 py-1 text-down transition-colors hover:bg-down/10 disabled:opacity-40"
                      >
                        REMOVE
                      </button>
                    </div>
                  </div>

                  {c.permissions && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      <Tag tone={c.permissions.withdrawals ? "down" : "up"}>
                        WITHDRAWALS {c.permissions.withdrawals ? "ENABLED" : "OFF"}
                      </Tag>
                      <Tag tone={c.permissions.reading ? "neutral" : "warn"}>
                        READ {c.permissions.reading ? "YES" : "NO"}
                      </Tag>
                      <Tag tone="neutral">SPOT {c.permissions.spotTrading ? "YES" : "NO"}</Tag>
                      <Tag tone={c.permissions.ipRestricted ? "neutral" : "warn"}>
                        IP ALLOWLIST {c.permissions.ipRestricted ? "SET" : "NONE"}
                      </Tag>
                    </div>
                  )}

                  {c.blockedReason && (
                    <p
                      className={cx(
                        "mt-2.5 text-[11px] leading-relaxed",
                        c.permissions?.withdrawals ? "text-down" : "text-dim",
                      )}
                    >
                      {c.blockedReason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {note && (
            <div className="border-t border-line px-3 py-2.5 text-[11px] text-warn">{note}</div>
          )}
        </Panel>

        <AddCredential onAdded={refresh} disabled={!vaultReady} />
      </div>

      <Panel
        label="BALANCES"
        hint="LIVE · READ-ONLY"
        right={
          balances.data?.unpriced.length ? (
            <Tag tone="warn">{balances.data.unpriced.length} UNPRICED</Tag>
          ) : null
        }
        flush
      >
        <BalanceTable data={balances.data} />
      </Panel>
    </div>
  );
}

/* --------------------------------------------------------------- banners */

function VaultKeyBanner() {
  return (
    <div className="border border-warn/30 bg-warn/5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="warn">VAULT KEY MISSING</Tag>
        <span className="text-[12px] text-muted">
          Credentials cannot be stored without a master key.
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-dim">
        Generate one with{" "}
        <code className="text-muted">openssl rand -base64 32</code> and put it in{" "}
        <code className="text-muted">.env.local</code> as{" "}
        <code className="text-muted">VAULT_KEY=…</code>. It is never written to disk by
        this system, and losing it means re-adding every credential.
      </p>
    </div>
  );
}

function WithdrawalBlockBanner({ count }: { count: number }) {
  return (
    <div className="border border-down/35 bg-down/5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="down">BLOCKED</Tag>
        <span className="text-[12px] text-muted">
          {count} credential{count === 1 ? " has" : "s have"} withdrawal permission
          enabled and cannot be used.
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-dim">
        Disable withdrawals on the exchange, then re-verify. There is deliberately no
        override — a key that can move funds out is the one thing a compromised process
        must not be handed.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------- add */

function AddCredential({
  onAdded,
  disabled,
}: {
  onAdded: () => void;
  disabled: boolean;
}) {
  const [venue, setVenue] = useState<VenueId>("binance");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const venueInfo = VENUES.find((v) => v.id === venue)!;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", venue, label, apiKey, apiSecret }),
      });
      const d = (await r.json()) as { error?: string };
      if (d.error) {
        setError(d.error);
      } else {
        // Clearing immediately keeps the secret out of React state for any
        // longer than the request needs it.
        setApiKey("");
        setApiSecret("");
        setLabel("");
        onAdded();
      }
    } catch {
      setError("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label="ADD CREDENTIAL" hint="STORED ENCRYPTED, ADDED DISABLED">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Micro className="mb-1.5">VENUE</Micro>
          <div className="flex flex-wrap gap-1">
            {VENUES.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setVenue(v.id)}
                disabled={!v.supported}
                className={cx(
                  "micro border px-2 py-1 transition-colors",
                  venue === v.id
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-line-bright text-dim hover:text-muted",
                  !v.supported && "cursor-not-allowed opacity-40",
                )}
              >
                {v.name.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-dim">{venueInfo.note}</p>
        </div>

        <div>
          <Micro className="mb-1.5">LABEL</Micro>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Binance main"
            className="w-full border border-line-bright bg-raised/60 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
          />
        </div>

        <div>
          <Micro className="mb-1.5">API KEY</Micro>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full border border-line-bright bg-raised/60 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
          />
        </div>

        <div>
          <Micro className="mb-1.5">API SECRET</Micro>
          <input
            type="password"
            autoComplete="off"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            className="w-full border border-line-bright bg-raised/60 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
          />
        </div>

        <button
          type="submit"
          disabled={busy || disabled || !venueInfo.supported}
          className="micro w-full border border-accent/50 bg-accent/10 py-2 text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
        >
          {busy ? "STORING…" : "STORE CREDENTIAL"}
        </button>

        {error && <p className="text-[11px] leading-relaxed text-down">{error}</p>}
      </form>

      <div className="mt-4 border-t border-line pt-3">
        <Micro className="mb-2">BEFORE YOU PASTE A KEY</Micro>
        <ul className="space-y-2">
          {[
            "Disable withdrawals on the key. A key with withdrawal permission is refused here and cannot be overridden.",
            "Set an IP allowlist to this machine's egress address. Strongly recommended, and warned about if absent.",
            "Enable reading only for now — there is no order path in this system yet, so trade permission buys nothing.",
            "The key is encrypted immediately and never rendered back. Losing VAULT_KEY means re-adding it.",
          ].map((t) => (
            <li key={t} className="flex gap-2.5 text-[11px] text-muted">
              <span className="mt-1.5 size-1 shrink-0 bg-accent" />
              <span className="leading-relaxed">{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------- balances */

function BalanceTable({ data }: { data: BalancesResponse | null }) {
  if (!data) return <div className="p-4 text-[12px] text-dim">Loading…</div>;

  if (data.note) {
    return <div className="p-4 text-[12px] text-dim">{data.note}</div>;
  }

  const rows = data.accounts.flatMap((a) =>
    a.balances.map((b) => ({ ...b, venue: a.venue, label: a.label })),
  );

  return (
    <div className="overflow-x-auto">
      {data.errors.length > 0 && (
        <div className="border-b border-line bg-down/5 px-3 py-2.5">
          {data.errors.map((e) => (
            <p key={e.credentialId} className="text-[11px] text-down">
              {e.message}
            </p>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="p-4 text-[12px] text-dim">
          No non-zero balances on any linked account.
        </div>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-line">
              <Th>ACCOUNT</Th>
              <Th>ASSET</Th>
              <Th right>FREE</Th>
              <Th right>LOCKED</Th>
              <Th right>TOTAL</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.venue}-${r.asset}`} className="border-b border-line/60">
                <Td>
                  <span className="text-ink">{r.label}</span>
                </Td>
                <Td>{r.asset}</Td>
                <Td right>
                  <span className="tnum">{r.free.toLocaleString("en-US", { maximumFractionDigits: 8 })}</span>
                </Td>
                <Td right>
                  <span className="tnum">{r.locked.toLocaleString("en-US", { maximumFractionDigits: 8 })}</span>
                </Td>
                <Td right>
                  <span className="tnum text-ink">
                    {r.total.toLocaleString("en-US", { maximumFractionDigits: 8 })}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.unpriced.length > 0 && (
        <p className="px-3 py-2.5 text-[11px] leading-relaxed text-warn">
          Could not price: {data.unpriced.join(", ")}. These are excluded from the
          account value rather than counted as zero — a silently understated NAV
          tightens every limit derived from it.
        </p>
      )}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cx(
        "micro whitespace-nowrap px-3 py-2 font-normal text-dim",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td
      className={cx(
        "whitespace-nowrap px-3 py-2 text-muted",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </td>
  );
}
