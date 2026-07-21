"use client";

/**
 * Command Center — the at-a-glance screen.
 *
 * Everything here is real. Where there is no data yet — no linked accounts, no
 * capital, no fills — it reads zero and says why, rather than showing a
 * plausible number. A trading dashboard that invents figures is worse than no
 * dashboard, because invented numbers look exactly as convincing as real ones.
 */

import Link from "next/link";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import type { CapitalEvent } from "@/lib/fund/ledger";
import { computePortfolio } from "@/lib/portfolio/sleeves";
import { resolveTier } from "@/lib/calc/tiers";
import { REJECTION_LABELS } from "@/lib/calc/gate";
import type { EngineConfig } from "@/lib/engine/config";
import type { ScoredOpportunity } from "@/lib/engine/scanner";
import type { MarketSnapshot, VenueError } from "@/lib/market/types";
import { TierLadder } from "@/components/ladder";
import { cx, Micro, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type FundResponse = {
  fund: { name: string; ownership: string; decisionMaker: string };
  nav: {
    navUsd: number;
    netContributedUsd: number;
    performanceIndex: number;
    twrPct: number;
    funded: boolean;
    nature: "simulated" | "real" | "mixed" | "none";
  };
  pnl: { totalUsd: number; realisedUsd: number; unrealisedUsd: number };
  operators: { id: string; name: string; initials: string; colorVar: string }[];
  events: CapitalEvent[];
};

type SignalsResponse = {
  asOf: number;
  errors: VenueError[];
  usingShadowSize: boolean;
  notionalUsd: number;
  opportunities: ScoredOpportunity[];
};

export default function CommandCenter() {
  const cfg = useLive<{ config: EngineConfig }>("/api/config", 30_000);
  const fundData = useLive<FundResponse>("/api/fund", 25_000);
  const markets = useLive<MarketSnapshot>("/api/markets", 15_000);
  const signals = useLive<SignalsResponse>("/api/signals", 25_000);
  const halt = useLive<{ state: { halted: boolean } }>("/api/halt", 20_000);

  const config = cfg.data?.config ?? null;
  // NAV is derived from the capital ledger plus trading P&L, never from config.
  const fund = fundData.data;
  const nav = fund?.nav.navUsd ?? 0;
  const tier = resolveTier(nav, 0, "T0").current;

  const opps = signals.data?.opportunities ?? [];
  const viable = opps.filter((o) => o.wouldTake);
  const best = viable[0] ?? null;

  const venues = markets.data ? [...new Set(markets.data.quotes.map((q) => q.venue))] : [];
  const portfolio = computePortfolio(nav, config?.sleeves ?? []);

  return (
    <div className="space-y-3 p-3">
      {!fund?.nav.funded && <UnfundedBanner halted={halt.data?.state.halted ?? false} />}

      {/* ------------------------------------------------------------ hero */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.55fr_1fr]">
        <Panel
          label="NET ASSET VALUE"
          hint="POOLED FUND · UNIT ACCOUNTED"
          right={
            <div className="flex items-center gap-1.5">
              <Tag>{fund?.fund.name ?? "—"}</Tag>
              <Tag tone={(fund?.nav.twrPct ?? 0) >= 0 ? "up" : "down"}>
                TWR {(fund?.nav.twrPct ?? 0) >= 0 ? "+" : ""}
                {((fund?.nav.twrPct ?? 0) * 100).toFixed(3)}%
              </Tag>
            </div>
          }
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <span className="text-[34px] leading-none tracking-tight text-ink">
                <Money usd={nav} />
              </span>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
                <Micro>CONTRIBUTED</Micro>
                <span className="text-muted">
                  <Money usd={fund?.nav.netContributedUsd ?? 0} />
                </span>
                <span className="text-dim">·</span>
                <Micro>P&amp;L</Micro>
                <span
                  className={cx(
                    (fund?.pnl.totalUsd ?? 0) > 0
                      ? "text-up"
                      : (fund?.pnl.totalUsd ?? 0) < 0
                        ? "text-down"
                        : "text-muted",
                  )}
                >
                  <Money usd={fund?.pnl.totalUsd ?? 0} sign />
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Stat label="TIER" sub={<span className="text-dim">{tier.name}</span>}>
                <span className="text-accent">{tier.id}</span>
              </Stat>
              <Stat label="LIVE STRATEGIES" sub={<span className="text-dim">permitted here</span>}>
                <span className="text-ink">
                  {tier.liveStrategies.length > 0 ? tier.liveStrategies.join(" · ") : "none"}
                </span>
              </Stat>
            </div>
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <TierLadder navUsd={nav} />
          </div>
        </Panel>

        <div className="space-y-3">
          <Panel label="FUND" hint="WHOLLY OWNED · SYSTEMATIC">
            <dl className="space-y-2.5 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Owner</dt>
                <dd className="text-ink">{fund?.fund.name ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Performance index</dt>
                <dd className="tnum text-muted">
                  {(fund?.nav.performanceIndex ?? 1).toFixed(6)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Decisions</dt>
                <dd className="max-w-[60%] text-right text-muted">
                  {fund?.fund.decisionMaker ?? "—"}
                </dd>
              </div>
            </dl>

            <div className="mt-3 border-t border-line pt-3">
              <Micro className="mb-2">OPERATORS</Micro>
              <div className="flex flex-wrap gap-1.5">
                {(fund?.operators ?? []).map((o) => (
                  <span
                    key={o.id}
                    title={o.name}
                    className="flex size-6 items-center justify-center border text-[9px]"
                    style={{
                      borderColor: `color-mix(in oklab, var(${o.colorVar}) 45%, transparent)`,
                      color: `var(${o.colorVar})`,
                    }}
                  >
                    {o.initials}
                  </span>
                ))}
              </div>
              <p className="mt-2.5 text-[11px] leading-relaxed text-dim">
                Attribution for the audit trail. No one holds a portion — the
                fund is wholly owned and traded by rules, not by a person.
              </p>
            </div>
          </Panel>

          <Panel label="VENUE HEALTH" hint="PUBLIC MARKET FEEDS">
            {venues.length === 0 && !markets.data ? (
              <div className="text-[11px] text-dim">Connecting to venues…</div>
            ) : (
              <ul className="space-y-2.5">
                {venues.map((v) => {
                  const n = markets.data!.quotes.filter((q) => q.venue === v).length;
                  return (
                    <li key={v} className="flex items-center gap-2.5">
                      <StatusDot state="ok" pulse />
                      <span className="flex-1 text-[12.5px] text-ink">{v}</span>
                      <span className="micro text-dim">{n} markets</span>
                    </li>
                  );
                })}
                {markets.data?.errors.map((e) => (
                  <li key={e.venue} className="flex items-center gap-2.5">
                    <StatusDot state="bad" />
                    <span className="flex-1 text-[12.5px] text-ink">{e.venue}</span>
                    <span className="micro text-down">{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
              Public price feeds only. No API credentials are configured, so
              nothing here can place an order or read a balance.
            </p>
          </Panel>
        </div>
      </div>

      {/* ------------------------------------------------------- scanner row */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Panel label="SCANNER">
          <Stat label="OPPORTUNITIES SCORED" sub={<span className="text-dim">latest scan</span>}>
            <span className="tnum text-[22px] text-ink">{opps.length}</span>
          </Stat>
        </Panel>
        <Panel label="POSITIVE NET EDGE">
          <Stat label="WOULD BE TAKEN" sub={<span className="text-dim">clears every gate</span>}>
            <span className={cx("tnum text-[22px]", viable.length > 0 ? "text-up" : "text-muted")}>
              {viable.length}
            </span>
          </Stat>
        </Panel>
        <Panel label="BEST EDGE">
          <Stat
            label={best ? `${best.asset} · ${best.strategy}` : "NONE FOUND"}
            sub={best && <span className="text-dim">{best.route}</span>}
          >
            {best ? (
              <span className="tnum text-[22px] text-up">{best.netBps.toFixed(1)}bp</span>
            ) : (
              <span className="text-[22px] text-dim">—</span>
            )}
          </Stat>
        </Panel>
        <Panel label="OPEN POSITIONS">
          <Stat label="ACROSS ALL VENUES" sub={<span className="text-dim">no capital deployed</span>}>
            <span className="tnum text-[22px] text-muted">0</span>
          </Stat>
        </Panel>
      </div>

      {/* ----------------------------------------------------------- sleeves */}
      <Panel
        label="SLEEVES"
        hint="SEPARATELY MANDATED BOOKS · INDEPENDENT RISK LIMITS"
        right={
          <Link href="/allocation" className="micro text-accent hover:underline">
            ALLOCATE →
          </Link>
        }
        flush
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line">
                <Th>SLEEVE</Th>
                <Th>MANDATE</Th>
                <Th right>ALLOCATED</Th>
                <Th right>SHARE</Th>
                <Th right>TARGET APR</Th>
                <Th right>EXPECT DD</Th>
                <Th>STATE</Th>
              </tr>
            </thead>
            <tbody>
              {portfolio.sleeves.map((s) => (
                <tr key={s.def.id} className="border-b border-line/60">
                  <Td>
                    <span className="text-ink">{s.def.name}</span>
                  </Td>
                  <Td>
                    <span className="text-dim">{s.def.strategies.join(" · ")}</span>
                  </Td>
                  <Td right>
                    <Money usd={s.allocatedUsd} />
                  </Td>
                  <Td right>
                    <span className="tnum">{(s.shareOfNav * 100).toFixed(0)}%</span>
                  </Td>
                  <Td right>
                    <span className="tnum">
                      <span className={s.def.targetAprLow < 0 ? "text-down" : "text-up"}>
                        {(s.def.targetAprLow * 100).toFixed(0)}%
                      </span>
                      <span className="text-dim"> … </span>
                      <span className="text-up">{(s.def.targetAprHigh * 100).toFixed(0)}%</span>
                    </span>
                  </Td>
                  <Td right>
                    <span className="tnum text-warn">
                      −{(s.def.expectedMaxDrawdown * 100).toFixed(0)}%
                    </span>
                  </Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      <StatusDot
                        state={s.tradable ? "ok" : s.allocation.halted ? "bad" : "idle"}
                        pulse={s.tradable}
                      />
                      <span className="text-dim" title={s.blockedReason ?? undefined}>
                        {s.tradable ? "ready" : s.allocation.halted ? "halted" : "inactive"}
                      </span>
                    </span>
                  </Td>
                </tr>
              ))}
              <tr>
                <Td>
                  <span className="text-muted">Reserve</span>
                </Td>
                <Td>
                  <span className="text-dim">unassigned buffer</span>
                </Td>
                <Td right>
                  <Money usd={portfolio.reserveUsd} />
                </Td>
                <Td right>
                  <span className="tnum">
                    {(Math.max(portfolio.reserveShare, 0) * 100).toFixed(0)}%
                  </span>
                </Td>
                <Td right>
                  <span className="text-dim">—</span>
                </Td>
                <Td right>
                  <span className="text-dim">—</span>
                </Td>
                <Td>
                  <span className="text-dim">cash</span>
                </Td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ---------------------------------------------------------- signals */}
      <Panel
        label="TOP SIGNALS"
        hint="BEST NET EDGE, TAKEN OR NOT"
        right={
          <Link href="/signals" className="micro text-accent hover:underline">
            FULL FEED →
          </Link>
        }
        flush
      >
        {opps.length === 0 ? (
          <div className="p-4 text-[12px] text-dim">
            {signals.status === "connecting"
              ? "Scanning live markets…"
              : "No opportunities scored in the latest scan."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>ST</Th>
                  <Th>ASSET</Th>
                  <Th>ROUTE</Th>
                  <Th right>FUNDING APR</Th>
                  <Th right>NET EDGE</Th>
                  <Th right>NET APR</Th>
                  <Th>DECISION</Th>
                </tr>
              </thead>
              <tbody>
                {opps.slice(0, 8).map((o) => (
                  <tr key={o.id} className="border-b border-line/60 hover:bg-raised/40">
                    <Td>
                      <span className="micro text-accent" title={o.strategyName}>
                        {o.strategy}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-ink">{o.asset}</span>
                    </Td>
                    <Td>
                      <span className="text-dim">{o.route}</span>
                    </Td>
                    <Td right>
                      {o.fundingApr === undefined ? (
                        <span className="text-dim">—</span>
                      ) : (
                        <span className={cx("tnum", o.fundingApr >= 0 ? "text-up" : "text-down")}>
                          {(o.fundingApr * 100).toFixed(2)}%
                        </span>
                      )}
                    </Td>
                    <Td right>
                      <span
                        className={cx(
                          "tnum",
                          o.netBps > 0 ? "text-up" : o.netBps < 0 ? "text-down" : "text-muted",
                        )}
                      >
                        {o.netBps > 0 ? "+" : ""}
                        {o.netBps.toFixed(1)}bp
                      </span>
                    </Td>
                    <Td right>
                      {o.netApr === null ? (
                        <span className="text-dim">—</span>
                      ) : (
                        <span className={cx("tnum", o.netApr >= 0 ? "text-up" : "text-down")}>
                          {(o.netApr * 100).toFixed(1)}%
                        </span>
                      )}
                    </Td>
                    <Td>
                      {o.wouldTake ? (
                        <Tag tone="up">WOULD TAKE</Tag>
                      ) : (
                        <span className="text-dim" title={o.rejectionDetail ?? undefined}>
                          {o.rejectionCode ? REJECTION_LABELS[o.rejectionCode] : "—"}
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function UnfundedBanner({ halted }: { halted: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border border-accent/25 bg-accent/5 px-3 py-2.5">
      <Tag tone="accent">TIER 0 · SHADOW</Tag>
      <span className="text-[12px] text-muted">
        No exchange accounts are linked and no capital is deployed, so every
        strategy runs in shadow: real data, real scoring, no orders. The valuable
        output at this tier is evidence, not returns.
      </span>
      {halted && <Tag tone="down">GLOBAL HALT ACTIVE</Tag>}
      <Link href="/control" className="micro ml-auto text-accent hover:underline">
        CONFIGURE →
      </Link>
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
