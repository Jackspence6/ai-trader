"use client";

/**
 * Treasury — what we hold, where it sits, and who it belongs to.
 *
 * The object model is DESIGN.md §7: operators hold units of a pooled fund;
 * the fund holds venue accounts; venue accounts hold balances. Unit accounting
 * is in place from the start because it is impossible to retrofit accurately —
 * once contributions have happened at different NAVs, you cannot reconstruct
 * who owns what from balances alone.
 *
 * Today every figure is zero, and that is the correct reading: no venue account
 * is linked, so there is nothing to report. The onboarding requirements below
 * are shown because they are the actual gate between this state and a funded
 * one.
 */

import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import { computeFundState, CAPITAL_EVENTS } from "@/lib/fund";
import { resolveTier } from "@/lib/calc/tiers";
import { DEFAULT_VENUE_FEES } from "@/lib/calc/costs";
import type { EngineConfig } from "@/lib/engine/config";
import { TierLadder } from "@/components/ladder";
import { cx, Micro, Panel, Stat, StatusDot, Tag } from "@/components/ui";

export default function Treasury() {
  const cfg = useLive<{ config: EngineConfig }>("/api/config", 30_000);
  const nav = cfg.data?.config.navUsd ?? 0;
  const fund = computeFundState(nav);
  const tierState = resolveTier(nav, 0, "T0");

  return (
    <div className="space-y-3 p-3">
      {/* ------------------------------------------------------ summary row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Panel>
          <Stat label="NET ASSET VALUE" sub={<span className="text-dim">marked to USD</span>}>
            <span className="text-[19px]">
              <Money usd={fund.navUsd} />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="CONTRIBUTED" sub={<span className="text-dim">net of withdrawals</span>}>
            <span className="text-[19px]">
              <Money usd={fund.totalContributedUsd - fund.totalWithdrawnUsd} />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="NAV / UNIT" sub={<span className="text-dim">fund unit price</span>}>
            <span className="tnum text-[19px]">{fund.navPerUnit.toFixed(4)}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="UNITS OUTSTANDING" sub={<span className="text-dim">all operators</span>}>
            <span className="tnum text-[19px]">{fund.unitsOutstanding.toFixed(2)}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="LINKED VENUES" sub={<span className="text-dim">trade-only keys</span>}>
            <span className="tnum text-[19px] text-muted">0</span>
          </Stat>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1.1fr]">
        {/* ------------------------------------------------------ operators */}
        <Panel
          label="OPERATORS"
          hint="UNIT-ACCOUNTED OWNERSHIP"
          right={<Tag>{fund.positions.length} MEMBERS</Tag>}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>OPERATOR</Th>
                  <Th right>UNITS</Th>
                  <Th right>SHARE</Th>
                  <Th right>CONTRIBUTED</Th>
                  <Th right>VALUE</Th>
                  <Th right>P&amp;L</Th>
                </tr>
              </thead>
              <tbody>
                {fund.positions.map((p) => (
                  <tr key={p.operator.id} className="border-b border-line/60">
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <span
                          className="flex size-6 shrink-0 items-center justify-center border text-[10px]"
                          style={{
                            borderColor: `color-mix(in oklab, var(${p.operator.colorVar}) 45%, transparent)`,
                            color: `var(${p.operator.colorVar})`,
                          }}
                        >
                          {p.operator.initials}
                        </span>
                        <span className="text-ink">{p.operator.name}</span>
                      </span>
                    </Td>
                    <Td right>
                      <span className="tnum">{p.units.toFixed(2)}</span>
                    </Td>
                    <Td right>
                      <span className="tnum">{(p.share * 100).toFixed(1)}%</span>
                    </Td>
                    <Td right>
                      <Money usd={p.contributedUsd} />
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

          <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            Each contribution buys units at the NAV per unit prevailing at that
            moment; each withdrawal redeems them. This keeps ownership correct
            regardless of contribution timing — if one operator adds capital right
            before a good week, naive percentage splitting would credit everyone
            equally and be simply wrong.
          </p>
        </Panel>

        {/* -------------------------------------------------------- ladder */}
        <Panel
          label="CAPITAL LADDER"
          hint="CAPABILITY GATED ON NAV"
          right={
            <Tag tone="accent">
              {tierState.current.id} · {tierState.current.name.toUpperCase()}
            </Tag>
          }
        >
          <TierLadder navUsd={nav} />
        </Panel>
      </div>

      {/* ------------------------------------------------------- accounts */}
      <Panel
        label="VENUE ACCOUNTS"
        hint="NONE LINKED"
        right={<Tag tone="warn">SETUP REQUIRED</Tag>}
      >
        <div className="mb-4 flex items-center gap-2.5 border border-line-bright bg-raised/30 px-3 py-2.5">
          <StatusDot state="idle" />
          <span className="text-[12px] text-muted">
            No exchange credentials are configured. The system is reading public
            market data only and cannot place orders or read balances.
          </span>
        </div>

        <Micro className="mb-2.5">ONBOARDING REQUIREMENTS PER ACCOUNT</Micro>
        <ul className="mb-4 space-y-2">
          {[
            "API key must be trade-only — the system hard-blocks any key with withdrawal permission enabled, and re-verifies it continuously",
            "IP whitelist configured against our current egress address",
            "Auto-discovery of balances, open positions, tradable markets and current fee tier",
            "Connectivity and latency test, plus a signed read to prove the credential works end to end",
            "Per-venue exposure cap and an assigned purpose — which strategies may use this account",
          ].map((r) => (
            <li key={r} className="flex gap-2.5 text-[12px] text-muted">
              <span className="mt-[7px] size-1 shrink-0 bg-accent" />
              <span className="leading-relaxed">{r}</span>
            </li>
          ))}
        </ul>

        <Micro className="mb-2.5">PLANNED VENUES · PUBLISHED BASE FEES</Micro>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line">
                <Th>VENUE</Th>
                <Th right>SPOT MAKER/TAKER</Th>
                <Th right>PERP MAKER/TAKER</Th>
                <Th right>MIN NOTIONAL</Th>
                <Th right>STATUS</Th>
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
                    <span className="tnum">${v.minNotionalUsd}</span>
                  </Td>
                  <Td right>
                    <span className="micro text-dim">FEED ONLY</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          These are published base-tier fees used as a conservative default. Once
          an account is linked the real tier is synced per venue — trading against
          a stale fee assumption makes every edge calculation in the system
          quietly wrong.
        </p>
      </Panel>

      {/* --------------------------------------------------------- ledger */}
      <Panel label="CAPITAL EVENTS" hint="CONTRIBUTIONS AND WITHDRAWALS">
        {CAPITAL_EVENTS.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-dim">
            No contributions or withdrawals recorded. Every external deposit will
            be surfaced here for explicit classification as an operator
            contribution rather than silently changing NAV — an unexplained
            balance change should never be quietly absorbed.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cx(
        "micro whitespace-nowrap px-2.5 py-2 font-normal text-dim",
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
        "whitespace-nowrap px-2.5 py-2 text-muted",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </td>
  );
}
