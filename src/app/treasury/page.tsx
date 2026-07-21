"use client";

/**
 * Treasury — the capital ledger, and the balance everything else sizes against.
 *
 * NAV here is **derived**, never typed: net capital contributed plus trading
 * P&L. That is what makes it compound, and what makes a wrong number
 * noticeable — if it moves, something happened and you can find out what.
 *
 * Deposits and withdrawals are recorded per operator and priced in units at the
 * NAV per unit prevailing at the time, so contribution timing stays fair. A
 * deposit made after a profitable month buys fewer units and does not dilute a
 * gain it did not fund.
 */

import { useCallback, useState } from "react";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import { resolveTier } from "@/lib/calc/tiers";
import { DEFAULT_VENUE_FEES } from "@/lib/calc/costs";
import type { CapitalEvent } from "@/lib/fund/ledger";
import { TierLadder } from "@/components/ladder";
import { cx, Micro, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type FundResponse = {
  nav: {
    navUsd: number;
    netContributedUsd: number;
    navPerUnit: number;
    unitsOutstanding: number;
    returnPct: number | null;
    funded: boolean;
    nature: "simulated" | "real" | "mixed" | "none";
    mixed: boolean;
  };
  pnl: {
    realisedUsd: number;
    unrealisedUsd: number;
    fundingUsd: number;
    feesUsd: number;
    totalUsd: number;
  };
  operators: {
    id: string;
    name: string;
    initials: string;
    colorVar: string;
    units: number;
    depositedUsd: number;
    withdrawnUsd: number;
    valueUsd: number;
    pnlUsd: number;
    share: number;
  }[];
  events: CapitalEvent[];
  openPositions: number;
  unpriced: string[];
  availableOperators: { id: string; name: string }[];
};

export default function Treasury() {
  const fund = useLive<FundResponse>("/api/fund", 20_000);
  const d = fund.data;
  const nav = d?.nav;
  const tier = resolveTier(nav?.navUsd ?? 0, 0, "T0");

  return (
    <div className="space-y-3 p-3">
      {nav && <NatureBanner nature={nav.nature} funded={nav.funded} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Panel>
          <Stat label="NET ASSET VALUE" sub={<span className="text-dim">derived</span>}>
            <span className="text-[19px]">
              <Money usd={nav?.navUsd ?? 0} />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="CONTRIBUTED" sub={<span className="text-dim">net of withdrawals</span>}>
            <span className="text-[19px]">
              <Money usd={nav?.netContributedUsd ?? 0} />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="TRADING P&L" sub={<span className="text-dim">all sources</span>}>
            <span
              className={cx(
                "text-[19px]",
                (d?.pnl.totalUsd ?? 0) > 0
                  ? "text-up"
                  : (d?.pnl.totalUsd ?? 0) < 0
                    ? "text-down"
                    : "text-muted",
              )}
            >
              <Money usd={d?.pnl.totalUsd ?? 0} sign />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="RETURN" sub={<span className="text-dim">on capital in</span>}>
            {nav?.returnPct === null || nav?.returnPct === undefined ? (
              <span className="text-[19px] text-dim">—</span>
            ) : (
              <span
                className={cx("tnum text-[19px]", nav.returnPct >= 0 ? "text-up" : "text-down")}
              >
                {nav.returnPct >= 0 ? "+" : ""}
                {(nav.returnPct * 100).toFixed(2)}%
              </span>
            )}
          </Stat>
        </Panel>
        <Panel>
          <Stat label="NAV / UNIT" sub={<span className="text-dim">unit price</span>}>
            <span className="tnum text-[19px]">{(nav?.navPerUnit ?? 1).toFixed(4)}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="OPEN POSITIONS" sub={<span className="text-dim">right now</span>}>
            <span className="tnum text-[19px] text-muted">{d?.openPositions ?? 0}</span>
          </Stat>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.15fr_1fr]">
        <Panel label="OPERATORS" hint="UNIT-ACCOUNTED OWNERSHIP" flush>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>OPERATOR</Th>
                  <Th right>UNITS</Th>
                  <Th right>SHARE</Th>
                  <Th right>IN</Th>
                  <Th right>OUT</Th>
                  <Th right>VALUE</Th>
                  <Th right>P&amp;L</Th>
                </tr>
              </thead>
              <tbody>
                {(d?.operators ?? []).map((p) => (
                  <tr key={p.id} className="border-b border-line/60">
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <span
                          className="flex size-6 shrink-0 items-center justify-center border text-[10px]"
                          style={{
                            borderColor: `color-mix(in oklab, var(${p.colorVar}) 45%, transparent)`,
                            color: `var(${p.colorVar})`,
                          }}
                        >
                          {p.initials}
                        </span>
                        <span className="text-ink">{p.name}</span>
                      </span>
                    </Td>
                    <Td right>
                      <span className="tnum">{p.units.toFixed(2)}</span>
                    </Td>
                    <Td right>
                      <span className="tnum">{(p.share * 100).toFixed(1)}%</span>
                    </Td>
                    <Td right>
                      <Money usd={p.depositedUsd} dp={0} />
                    </Td>
                    <Td right>
                      <span className="text-dim">
                        <Money usd={p.withdrawnUsd} dp={0} />
                      </span>
                    </Td>
                    <Td right>
                      <span className="text-ink">
                        <Money usd={p.valueUsd} />
                      </span>
                    </Td>
                    <Td right>
                      <span
                        className={cx(
                          p.pnlUsd > 0 ? "text-up" : p.pnlUsd < 0 ? "text-down" : "text-muted",
                        )}
                      >
                        <Money usd={p.pnlUsd} sign />
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
            Each deposit buys units at the NAV per unit prevailing at that
            moment. That keeps ownership correct regardless of timing — a
            deposit after a good month buys fewer units and does not dilute the
            gain it did not fund.
          </p>
        </Panel>

        <CapitalForm
          operators={d?.availableOperators ?? []}
          currentNature={nav?.nature ?? "none"}
          onDone={() => fund.refresh()}
        />
      </div>

      <Panel label="WHERE THE P&L CAME FROM" hint="EVERY COMPONENT, SIGNED">
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-5">
          <Stat label="REALISED" sub={<span className="text-dim">closed trades</span>}>
            <span className={cx((d?.pnl.realisedUsd ?? 0) >= 0 ? "text-up" : "text-down")}>
              <Money usd={d?.pnl.realisedUsd ?? 0} sign />
            </span>
          </Stat>
          <Stat label="UNREALISED" sub={<span className="text-dim">open, marked</span>}>
            <span className={cx((d?.pnl.unrealisedUsd ?? 0) >= 0 ? "text-up" : "text-down")}>
              <Money usd={d?.pnl.unrealisedUsd ?? 0} sign />
            </span>
          </Stat>
          <Stat label="FUNDING" sub={<span className="text-dim">carry income</span>}>
            <span className={cx((d?.pnl.fundingUsd ?? 0) >= 0 ? "text-up" : "text-down")}>
              <Money usd={d?.pnl.fundingUsd ?? 0} sign />
            </span>
          </Stat>
          <Stat label="FEES" sub={<span className="text-dim">always a cost</span>}>
            <span className="text-down">
              −<Money usd={d?.pnl.feesUsd ?? 0} />
            </span>
          </Stat>
          <Stat label="NET" sub={<span className="text-dim">what NAV moved by</span>}>
            <span
              className={cx("text-[15px]", (d?.pnl.totalUsd ?? 0) >= 0 ? "text-up" : "text-down")}
            >
              <Money usd={d?.pnl.totalUsd ?? 0} sign />
            </span>
          </Stat>
        </div>
        {d && d.unpriced.length > 0 && (
          <p className="mt-3 border-t border-line pt-3 text-[11px] text-warn">
            Could not price {d.unpriced.join(", ")} — excluded from unrealised
            rather than counted as zero.
          </p>
        )}
      </Panel>

      <Panel
        label="CAPITAL LADDER"
        hint="CAPABILITY GATED ON NAV"
        right={
          <Tag tone="accent">
            {tier.current.id} · {tier.current.name.toUpperCase()}
          </Tag>
        }
      >
        <TierLadder navUsd={nav?.navUsd ?? 0} />
      </Panel>

      <Panel label="CAPITAL EVENTS" hint="EVERY DEPOSIT AND WITHDRAWAL" flush>
        {!d || d.events.length === 0 ? (
          <div className="p-4 text-[12px] text-dim">
            No deposits recorded. NAV stays at zero until capital is added, and
            nothing will trade — which is correct, not a fault.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>WHEN</Th>
                  <Th>OPERATOR</Th>
                  <Th>TYPE</Th>
                  <Th>NATURE</Th>
                  <Th right>AMOUNT</Th>
                  <Th right>NAV/UNIT</Th>
                  <Th right>UNITS</Th>
                  <Th>NOTE</Th>
                </tr>
              </thead>
              <tbody>
                {d.events.map((e) => (
                  <tr key={e.id} className="border-b border-line/60">
                    <Td>
                      <span className="tnum text-dim">
                        {new Date(e.ts).toISOString().replace("T", " ").slice(0, 16)}
                      </span>
                    </Td>
                    <Td>{d.operators.find((o) => o.id === e.operatorId)?.name ?? e.operatorId}</Td>
                    <Td>
                      <span className={e.type === "deposit" ? "text-up" : "text-down"}>
                        {e.type.toUpperCase()}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className={cx("micro", e.nature === "real" ? "text-warn" : "text-dim")}
                      >
                        {e.nature.toUpperCase()}
                      </span>
                    </Td>
                    <Td right>
                      <Money usd={e.amountUsd} />
                    </Td>
                    <Td right>
                      <span className="tnum text-dim">{e.navPerUnitAtEvent.toFixed(4)}</span>
                    </Td>
                    <Td right>
                      <span className="tnum">{e.unitsDelta.toFixed(2)}</span>
                    </Td>
                    <Td>
                      <span className="text-dim">{e.note ?? "—"}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel label="VENUE ACCOUNTS" hint="NONE LINKED" right={<Tag tone="warn">SETUP REQUIRED</Tag>}>
        <div className="mb-4 flex items-center gap-2.5 border border-line-bright bg-raised/30 px-3 py-2.5">
          <StatusDot state="idle" />
          <span className="text-[12px] text-muted">
            No exchange credentials configured. Paper trading needs none — it
            uses public market data and simulated fills.
          </span>
        </div>

        <Micro className="mb-2.5">PLANNED VENUES · PUBLISHED BASE FEES</Micro>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line">
                <Th>VENUE</Th>
                <Th right>SPOT MAKER/TAKER</Th>
                <Th right>PERP MAKER/TAKER</Th>
                <Th right>MIN NOTIONAL (SPOT/PERP)</Th>
              </tr>
            </thead>
            <tbody>
              {Object.values(DEFAULT_VENUE_FEES).map((v) => (
                <tr key={v.venue} className="border-b border-line/60">
                  <Td>
                    <span className="text-ink">{v.venue}</span>
                  </Td>
                  <Td right>
                    <span className="tnum">
                      {v.spot.makerBps}/{v.spot.takerBps}bp
                    </span>
                  </Td>
                  <Td right>
                    <span className="tnum">
                      {v.perp.makerBps}/{v.perp.takerBps}bp
                    </span>
                  </Td>
                  <Td right>
                    <span className="tnum">
                      ${v.minNotionalUsd.spot} / ${v.minNotionalUsd.perp}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          Conservative published base-tier fees. Real minimums are per-market and
          per-symbol — Binance BTC perp is $50 while BTC spot is $5 — so a
          multi-leg trade is bound by the largest of its legs.
        </p>
      </Panel>
    </div>
  );
}

/* --------------------------------------------------------------- banner */

function NatureBanner({
  nature,
  funded,
}: {
  nature: "simulated" | "real" | "mixed" | "none";
  funded: boolean;
}) {
  if (nature === "none" || !funded) {
    return (
      <div className="flex flex-wrap items-center gap-2 border border-accent/25 bg-accent/5 px-3 py-2.5">
        <Tag tone="accent">NO CAPITAL</Tag>
        <span className="text-[12px] text-muted">
          Record a simulated deposit below to give the system a balance to trade
          against. Nothing will trade until you do.
        </span>
      </div>
    );
  }

  if (nature === "real") {
    return (
      <div className="flex flex-wrap items-center gap-2 border border-warn/35 bg-warn/5 px-3 py-2.5">
        <Tag tone="warn">REAL CAPITAL</Tag>
        <span className="text-[12px] text-muted">
          This ledger tracks real money. Every figure on this page is a real gain
          or loss.
        </span>
      </div>
    );
  }

  if (nature === "mixed") {
    return (
      <div className="flex flex-wrap items-center gap-2 border border-down/35 bg-down/5 px-3 py-2.5">
        <Tag tone="down">MIXED LEDGER</Tag>
        <span className="text-[12px] text-muted">
          This ledger contains both real and simulated capital. The track record
          it produces cannot be defended — separate them.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border border-accent/25 bg-accent/5 px-3 py-2.5">
      <Tag tone="accent">SIMULATED CAPITAL</Tag>
      <span className="text-[12px] text-muted">
        Hypothetical balance, real market data, simulated fills. Every P&amp;L
        figure is what these decisions would have produced — not money.
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- form */

function CapitalForm({
  operators,
  currentNature,
  onDone,
}: {
  operators: { id: string; name: string }[];
  currentNature: "simulated" | "real" | "mixed" | "none";
  onDone: () => void;
}) {
  const [operatorId, setOperatorId] = useState("");
  const [type, setType] = useState<"deposit" | "withdrawal">("deposit");
  const [nature, setNature] = useState<"simulated" | "real">("simulated");
  const [amount, setAmount] = useState("1000");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const r = await fetch("/api/fund", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operatorId: operatorId || operators[0]?.id,
            type,
            nature,
            amountUsd: Number(amount),
            note,
          }),
        });
        const d = (await r.json()) as { error?: string };
        if (d.error) setError(d.error);
        else {
          setAmount("1000");
          setNote("");
          onDone();
        }
      } catch {
        setError("Request failed");
      } finally {
        setBusy(false);
      }
    },
    [operatorId, operators, type, nature, amount, note, onDone],
  );

  return (
    <Panel label="DEPOSIT / WITHDRAW" hint="CHANGES NAV, WHICH CHANGES SIZING">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Micro className="mb-1.5">OPERATOR</Micro>
          <div className="flex flex-wrap gap-1">
            {operators.map((o, i) => {
              const active = operatorId === o.id || (!operatorId && i === 0);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setOperatorId(o.id)}
                  className={cx(
                    "micro border px-2 py-1 transition-colors",
                    active
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-line-bright text-dim hover:text-muted",
                  )}
                >
                  {o.name.toUpperCase()}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Micro className="mb-1.5">DIRECTION</Micro>
            <div className="flex">
              {(["deposit", "withdrawal"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={cx(
                    "micro flex-1 border px-2 py-1.5 transition-colors -ml-px first:ml-0",
                    type === t
                      ? t === "deposit"
                        ? "border-up/50 bg-up/10 text-up z-10"
                        : "border-down/50 bg-down/10 text-down z-10"
                      : "border-line-bright text-dim hover:text-muted",
                  )}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Micro className="mb-1.5">NATURE</Micro>
            <div className="flex">
              {(["simulated", "real"] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setNature(n)}
                  disabled={currentNature !== "none" && currentNature !== n}
                  className={cx(
                    "micro flex-1 border px-2 py-1.5 transition-colors -ml-px first:ml-0",
                    nature === n
                      ? n === "real"
                        ? "border-warn/50 bg-warn/10 text-warn z-10"
                        : "border-accent/50 bg-accent/10 text-accent z-10"
                      : "border-line-bright text-dim hover:text-muted",
                    currentNature !== "none" &&
                      currentNature !== n &&
                      "cursor-not-allowed opacity-30",
                  )}
                >
                  {n.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <Micro className="mb-1.5">AMOUNT (USD)</Micro>
          <input
            type="number"
            min={0}
            step={100}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="tnum w-full border border-line-bright bg-raised/60 px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent/50"
          />
        </div>

        <div>
          <Micro className="mb-1.5">NOTE (OPTIONAL)</Micro>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. initial paper stake"
            className="w-full border border-line-bright bg-raised/60 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
          />
        </div>

        <button
          type="submit"
          disabled={busy || operators.length === 0}
          className={cx(
            "micro w-full border py-2 transition-colors disabled:opacity-40",
            type === "deposit"
              ? "border-up/50 bg-up/10 text-up hover:bg-up/20"
              : "border-down/50 bg-down/10 text-down hover:bg-down/20",
          )}
        >
          {busy ? "RECORDING…" : `RECORD ${type.toUpperCase()}`}
        </button>

        {error && <p className="text-[11px] leading-relaxed text-down">{error}</p>}
      </form>

      <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
        Real and simulated capital cannot be mixed in one ledger — the option
        locks once the first event sets the nature. A mixed book produces a track
        record where you can no longer say which returns were earned with money
        at risk.
      </p>
    </Panel>
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
