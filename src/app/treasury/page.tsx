"use client";

/**
 * Treasury — the capital ledger, and the balance everything else sizes against.
 *
 * NAV here is **derived**, never typed: net capital contributed plus trading
 * P&L. That is what makes it compound, and what makes a wrong number
 * noticeable — if it moves, something happened and you can find out what.
 *
 * Capital is split across two accounts — a **crypto** book and a **forex**
 * book — because the two asset classes carry completely different risk and the
 * whole reason to hold both is to keep them separable. Each account has its own
 * balance, its own P&L, and is funded independently. The two always sum to the
 * fund total, because the total is computed as the sum, never a second way.
 *
 * The performance index is the number worth watching. It moves on trading P&L
 * alone and is unaffected by deposits, so it answers "is the strategy working?"
 * — which a balance cannot, because adding R5,000 and earning R5,000 look
 * identical on a balance.
 */

import { useCallback, useState } from "react";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import { resolveTier } from "@/lib/calc/tiers";
import { DEFAULT_VENUE_FEES } from "@/lib/calc/costs";
import type { CapitalEvent, FundAccount } from "@/lib/fund/ledger";
import { TierLadder } from "@/components/ladder";
import { cx, Micro, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type NavView = {
  navUsd: number;
  netContributedUsd: number;
  depositedUsd: number;
  withdrawnUsd: number;
  performanceIndex: number;
  twrPct: number;
  returnOnCapitalPct: number | null;
  funded: boolean;
  nature: "simulated" | "real" | "mixed" | "none";
  mixed: boolean;
};

type Pnl = {
  realisedUsd: number;
  unrealisedUsd: number;
  fundingUsd: number;
  feesUsd: number;
  totalUsd: number;
};

type AccountView = {
  account: FundAccount;
  label: string;
  note: string;
  nav: NavView;
  pnl: Pnl;
  openPositions: number;
  unpriced: string[];
};

type FundResponse = {
  fund: { name: string; ownership: string; decisionMaker: string };
  nav: NavView;
  pnl: Pnl;
  accounts: AccountView[];
  rates: {
    source: "live" | "cached" | "reference";
    asOf: string;
    usdPer: Record<string, number>;
    zarPerUsd: number | null;
  };
  events: CapitalEvent[];
  openPositions: number;
  unpriced: string[];
};

// Static class strings per account — Tailwind's JIT cannot see interpolated
// class names, so the crypto/forex accents are spelled out in full.
const ACCOUNT_STYLE: Record<
  FundAccount,
  { text: string; borderL: string; tag: string }
> = {
  crypto: { text: "text-accent", borderL: "border-accent/50", tag: "text-accent" },
  forex: { text: "text-fx", borderL: "border-fx/50", tag: "text-fx" },
};

export default function Treasury() {
  const fund = useLive<FundResponse>("/api/fund", 20_000);
  const d = fund.data;
  const nav = d?.nav;
  const tier = resolveTier(nav?.navUsd ?? 0, 0, "T0");

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {nav && <NatureBanner nature={nav.nature} funded={nav.funded} />}
        <div className="ml-auto flex items-center gap-2">
          <RateBadge rates={d?.rates} />
          <RefreshButton status={fund.status} ageSeconds={fund.ageSeconds} onClick={fund.refresh} />
        </div>
      </div>

      {/* ---------------------------------------------------- fund-wide stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Panel>
          <Stat label="NET ASSET VALUE" sub={<span className="text-dim">both accounts</span>}>
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
          <Stat
            label="PERFORMANCE INDEX"
            sub={<span className="text-dim">1.0000 at inception</span>}
          >
            <span
              className={cx(
                "tnum text-[19px]",
                (nav?.performanceIndex ?? 1) >= 1 ? "text-up" : "text-down",
              )}
            >
              {(nav?.performanceIndex ?? 1).toFixed(6)}
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat
            label="RETURN (TWR)"
            sub={<span className="text-dim">strategy only, ignores deposits</span>}
          >
            <span
              className={cx("tnum text-[19px]", (nav?.twrPct ?? 0) >= 0 ? "text-up" : "text-down")}
            >
              {(nav?.twrPct ?? 0) >= 0 ? "+" : ""}
              {((nav?.twrPct ?? 0) * 100).toFixed(4)}%
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="OPEN POSITIONS" sub={<span className="text-dim">right now</span>}>
            <span className="tnum text-[19px] text-muted">{d?.openPositions ?? 0}</span>
          </Stat>
        </Panel>
      </div>

      {/* ------------------------------------------------- the two accounts */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {(d?.accounts ?? []).map((a) => (
          <AccountCard key={a.account} a={a} />
        ))}
        {!d && <div className="p-4 text-[12px] text-dim">Loading accounts…</div>}
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.15fr_1fr]">
        <Panel label="FUND" hint="WHOLLY OWNED — NO FRACTIONAL STAKES">
          <dl className="space-y-2.5 text-[12px]">
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Owner</dt>
              <dd className="text-ink">{d?.fund.name ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Ownership</dt>
              <dd className="text-muted">{d?.fund.ownership ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Decisions</dt>
              <dd className="max-w-[60%] text-right text-muted">
                {d?.fund.decisionMaker ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Deposited</dt>
              <dd className="text-muted">
                <Money usd={nav?.depositedUsd ?? 0} />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Withdrawn</dt>
              <dd className="text-muted">
                <Money usd={nav?.withdrawnUsd ?? 0} />
              </dd>
            </div>
          </dl>

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            One owner, two accounts, one balance per account. Capital is split
            between the crypto and forex books so each can be funded and judged on
            its own — deposits go to whichever book you choose below.
          </p>
        </Panel>

        <CapitalForm
          currentNature={nav?.nature ?? "none"}
          zarPerUsd={d?.rates.zarPerUsd ?? null}
          onDone={() => fund.refresh()}
        />
      </div>

      <Panel label="WHERE THE P&L CAME FROM" hint="EVERY COMPONENT, SIGNED · BOTH ACCOUNTS">
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
                  <Th>ACCOUNT</Th>
                  <Th>TYPE</Th>
                  <Th>NATURE</Th>
                  <Th right>AMOUNT</Th>
                  <Th right>FUNDED AS</Th>
                  <Th right>INDEX AT EVENT</Th>
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
                    <Td>
                      <span
                        className={cx(
                          "micro",
                          ACCOUNT_STYLE[e.account ?? "crypto"]?.text ?? "text-muted",
                        )}
                      >
                        {(e.account ?? "crypto").toUpperCase()}
                      </span>
                    </Td>
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
                      {e.original ? (
                        <span className="tnum text-dim">
                          {e.original.currency === "ZAR" ? "R" : ""}
                          {e.original.amount.toLocaleString("en-US", {
                            maximumFractionDigits: 2,
                          })}{" "}
                          {e.original.currency}
                        </span>
                      ) : (
                        <span className="tnum text-dim">USD</span>
                      )}
                    </Td>
                    <Td right>
                      <span className="tnum text-dim">{e.navPerUnitAtEvent.toFixed(6)}</span>
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

/* --------------------------------------------------------------- account card */

function AccountCard({ a }: { a: AccountView }) {
  const style = ACCOUNT_STYLE[a.account] ?? ACCOUNT_STYLE.crypto;
  const pnl = a.pnl.totalUsd;
  const roc = a.nav.returnOnCapitalPct;

  return (
    <div className={cx("border-l-2 bg-panel", style.borderL)}>
      <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-3 py-2.5">
        <span className={cx("text-[13px] font-medium tracking-wide", style.text)}>
          {a.label.toUpperCase()} ACCOUNT
        </span>
        <span className="micro ml-auto text-dim">
          {a.openPositions} open · idx {a.nav.performanceIndex.toFixed(4)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 p-3">
        <Stat label="BALANCE" sub={<span className="text-dim">NAV</span>}>
          <span className="text-[17px]">
            <Money usd={a.nav.navUsd} />
          </span>
        </Stat>
        <Stat label="INVESTED" sub={<span className="text-dim">net contributed</span>}>
          <span className="text-[17px] text-muted">
            <Money usd={a.nav.netContributedUsd} />
          </span>
        </Stat>
        <Stat
          label="P&L"
          sub={
            <span className="text-dim">
              {roc === null ? "—" : `${roc >= 0 ? "+" : ""}${(roc * 100).toFixed(2)}% on capital`}
            </span>
          }
        >
          <span className={cx("text-[17px]", pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-muted")}>
            <Money usd={pnl} sign />
          </span>
        </Stat>
      </div>

      <p className="border-t border-line px-3 py-2.5 text-[11px] leading-relaxed text-dim">
        {a.note}
      </p>
      {a.unpriced.length > 0 && (
        <p className="border-t border-line px-3 py-2 text-[11px] text-warn">
          Unpriced: {a.unpriced.join(", ")} — excluded from this book&apos;s P&L.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- rate badge */

function RateBadge({ rates }: { rates?: FundResponse["rates"] }) {
  if (!rates) return null;
  const tone = rates.source === "live" ? "up" : rates.source === "cached" ? "accent" : "warn";
  const label =
    rates.source === "live"
      ? "LIVE FX"
      : rates.source === "cached"
        ? "CACHED FX"
        : "REFERENCE FX";
  return (
    <span
      className="flex items-center gap-1.5"
      title={
        rates.source === "live"
          ? `Live ECB reference fix (${rates.asOf})`
          : rates.source === "cached"
            ? "Provider briefly unreachable — using the last live rate we fetched"
            : "First fetch has not landed yet — approximate reference rate"
      }
    >
      <Tag tone={tone as "up" | "accent" | "warn"}>{label}</Tag>
      {rates.zarPerUsd && (
        <span className="micro tnum text-dim">1 USD = R{rates.zarPerUsd.toFixed(2)}</span>
      )}
    </span>
  );
}

function RefreshButton({
  status,
  ageSeconds,
  onClick,
}: {
  status: "connecting" | "live" | "stale" | "error";
  ageSeconds: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title="Refresh everything now"
      className="micro flex items-center gap-1.5 border border-line-bright px-2 py-1 text-dim transition-colors hover:text-ink"
    >
      <StatusDot state={status === "live" ? "ok" : status === "error" ? "bad" : "idle"} />
      REFRESH
      <span className="tnum opacity-60">{ageSeconds}s</span>
    </button>
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
          Record a deposit below to give an account a balance to trade against.
          Nothing will trade until you do.
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
  currentNature,
  zarPerUsd,
  onDone,
}: {
  currentNature: "simulated" | "real" | "mixed" | "none";
  zarPerUsd: number | null;
  onDone: () => void;
}) {
  const [account, setAccount] = useState<FundAccount>("crypto");
  const [type, setType] = useState<"deposit" | "withdrawal">("deposit");
  const [nature, setNature] = useState<"simulated" | "real">("simulated");
  const [currency, setCurrency] = useState<"ZAR" | "USD">("ZAR");
  const [amount, setAmount] = useState("5000");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amt = Number(amount);
  const usdPreview =
    currency === "USD"
      ? amt
      : zarPerUsd && zarPerUsd > 0 && Number.isFinite(amt)
        ? amt / zarPerUsd
        : null;

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const r = await fetch("/api/fund", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ account, type, nature, currency, amount: Number(amount), note }),
        });
        const d = (await r.json()) as { error?: string };
        if (d.error) setError(d.error);
        else {
          setNote("");
          onDone();
        }
      } catch {
        setError("Request failed");
      } finally {
        setBusy(false);
      }
    },
    [account, type, nature, currency, amount, note, onDone],
  );

  return (
    <Panel label="DEPOSIT / WITHDRAW" hint="CHANGES NAV, WHICH CHANGES SIZING">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Micro className="mb-1.5">ACCOUNT</Micro>
          <div className="flex">
            {(["crypto", "forex"] as const).map((ac) => (
              <button
                key={ac}
                type="button"
                onClick={() => setAccount(ac)}
                className={cx(
                  "micro flex-1 border px-2 py-1.5 transition-colors -ml-px first:ml-0",
                  account === ac
                    ? ac === "crypto"
                      ? "border-accent/50 bg-accent/10 text-accent z-10"
                      : "border-fx/50 bg-fx/10 text-fx z-10"
                    : "border-line-bright text-dim hover:text-muted",
                )}
              >
                {ac.toUpperCase()}
              </button>
            ))}
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
          <div className="mb-1.5 flex items-center justify-between">
            <Micro>AMOUNT</Micro>
            <div className="flex">
              {(["ZAR", "USD"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCurrency(c)}
                  className={cx(
                    "micro border px-1.5 py-0.5 transition-colors -ml-px first:ml-0",
                    currency === c
                      ? "border-accent/50 bg-accent/10 text-accent z-10"
                      : "border-line-bright text-dim hover:text-muted",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <input
            type="number"
            min={0}
            step={currency === "ZAR" ? 500 : 50}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="tnum w-full border border-line-bright bg-raised/60 px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent/50"
          />
          {currency === "ZAR" && (
            <p className="mt-1 text-[11px] text-dim">
              {usdPreview !== null ? (
                <>
                  ≈ <span className="tnum text-muted">${usdPreview.toFixed(2)}</span> at the
                  live rate. Converted server-side at deposit time; USD is stored as
                  canonical.
                </>
              ) : (
                "Converted at the live rate when recorded."
              )}
            </p>
          )}
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
          disabled={busy}
          className={cx(
            "micro w-full border py-2 transition-colors disabled:opacity-40",
            type === "deposit"
              ? "border-up/50 bg-up/10 text-up hover:bg-up/20"
              : "border-down/50 bg-down/10 text-down hover:bg-down/20",
          )}
        >
          {busy
            ? "RECORDING…"
            : `RECORD ${type.toUpperCase()} → ${account.toUpperCase()}`}
        </button>

        {error && <p className="text-[11px] leading-relaxed text-down">{error}</p>}
      </form>

      <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
        Fund in rands or dollars — a ZAR deposit is converted at the live rate the
        instant it is recorded, and the original rand figure is kept for audit.
        Real and simulated capital cannot be mixed across the fund: the option
        locks once the first event sets the nature, because a blended book
        produces a track record where you can no longer say which returns were
        earned with money at risk.
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
