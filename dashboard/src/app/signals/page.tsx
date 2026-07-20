"use client";

/**
 * Signals — every opportunity the scanners score, taken or rejected.
 *
 * DESIGN.md §8.2 argues this is the screen that matters most early, and that is
 * right. It is how you learn whether an edge is real before risking anything on
 * it, and how you answer "why isn't the system trading?" — a question that is
 * impossible to answer from PnL alone.
 *
 * So rejections are first-class content here, not hidden. Each one carries the
 * specific rule that stopped it and the numbers that rule compared.
 */

import { useMemo, useState } from "react";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import { REJECTION_LABELS, type RejectionCode } from "@/lib/calc/gate";
import type { ScoredOpportunity } from "@/lib/engine/scanner";
import type { VenueError } from "@/lib/market/types";
import { cx, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type SignalsResponse = {
  asOf: number;
  errors: VenueError[];
  usingShadowSize: boolean;
  notionalUsd: number;
  opportunities: ScoredOpportunity[];
};

export default function SignalsPage() {
  const { data, status, ageSeconds } = useLive<SignalsResponse>("/api/signals", 20_000);
  const [strategy, setStrategy] = useState<"all" | "L1" | "L2">("all");
  const [onlyViable, setOnlyViable] = useState(false);

  // Memoised so the fallback [] is not a fresh array on every render, which
  // would invalidate every downstream useMemo.
  const all = useMemo(() => data?.opportunities ?? [], [data]);

  const rows = useMemo(() => {
    let r = all;
    if (strategy !== "all") r = r.filter((o) => o.strategy === strategy);
    // "Viable" means the economics work — it excludes rejections that are about
    // capital or permission, which are the ones that would resolve on their own
    // once the fund is funded.
    if (onlyViable) r = r.filter((o) => o.netBps > 0);
    return r;
  }, [all, strategy, onlyViable]);

  // "Viable" = cleared every gate as though live. Positive edge alone is not
  // enough; a sleeve being off or underfunded still blocks it.
  const viable = all.filter((o) => o.wouldTake);
  const best = viable[0] ?? null;

  const byReason = useMemo(() => {
    const m = new Map<RejectionCode, number>();
    for (const o of all) {
      if (o.rejectionCode) m.set(o.rejectionCode, (m.get(o.rejectionCode) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  return (
    <div className="space-y-3 p-3">
      {data?.usingShadowSize && (
        <div className="flex flex-wrap items-center gap-2 border border-warn/30 bg-warn/5 px-3 py-2.5">
          <Tag tone="warn">SHADOW</Tag>
          <span className="text-[12px] text-muted">
            No capital is deployed. Opportunities are scored against a
            hypothetical{" "}
            <span className="text-ink">
              <Money usd={data.notionalUsd} dp={0} />
            </span>{" "}
            position so fees and slippage are realistic — these are measurements,
            not fundable trades.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Panel label="SCORED">
          <Stat label="OPPORTUNITIES" sub={<span className="text-dim">this scan</span>}>
            <span className="tnum text-[22px] text-ink">{all.length}</span>
          </Stat>
        </Panel>
        <Panel label="POSITIVE NET EDGE">
          <Stat
            label="AFTER ALL COSTS"
            sub={<span className="text-dim">clears every gate</span>}
          >
            <span
              className={cx(
                "tnum text-[22px]",
                viable.length > 0 ? "text-up" : "text-muted",
              )}
            >
              {viable.length}
            </span>
          </Stat>
        </Panel>
        <Panel label="BEST NET EDGE">
          <Stat
            label={best ? `${best.asset} · ${best.strategy}` : "NONE"}
            sub={best && <span className="text-dim">{best.route}</span>}
          >
            {best ? (
              <span className="tnum text-[22px] text-up">{best.netBps.toFixed(1)}bp</span>
            ) : (
              <span className="text-[22px] text-dim">—</span>
            )}
          </Stat>
        </Panel>
        <Panel label="FEED">
          <Stat
            label="SCANNER"
            sub={
              <span className="text-dim">
                {data ? new Date(data.asOf).toISOString().slice(11, 19) + " UTC" : "—"}
              </span>
            }
          >
            <span className="flex items-center gap-2 text-[15px]">
              <StatusDot
                state={
                  status === "live"
                    ? "ok"
                    : status === "stale"
                      ? "warn"
                      : status === "error"
                        ? "bad"
                        : "idle"
                }
                pulse={status === "live"}
              />
              <span className="text-muted">{status}</span>
              <span className="tnum text-dim">{ageSeconds}s</span>
            </span>
          </Stat>
        </Panel>
      </div>

      <Panel
        label="OPPORTUNITY FEED"
        hint="GROSS → NET, WITH THE DECIDING RULE"
        right={
          <div className="flex items-center gap-1">
            {(["all", "L1", "L2"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStrategy(s)}
                className={cx(
                  "micro border px-1.5 py-1 -ml-px first:ml-0 transition-colors",
                  strategy === s
                    ? "border-accent/50 bg-accent/10 text-accent z-10"
                    : "border-line-bright text-dim hover:text-muted",
                )}
              >
                {s === "all" ? "ALL" : s}
              </button>
            ))}
            <button
              onClick={() => setOnlyViable((v) => !v)}
              className={cx(
                "micro ml-2 border px-1.5 py-1 transition-colors",
                onlyViable
                  ? "border-up/50 bg-up/10 text-up"
                  : "border-line-bright text-dim hover:text-muted",
              )}
            >
              NET &gt; 0
            </button>
          </div>
        }
        flush
      >
        <OpportunityTable rows={rows} />
      </Panel>

      {byReason.length > 0 && (
        <Panel label="WHY WE ARE NOT TRADING" hint="REJECTION BREAKDOWN">
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {byReason.map(([code, n]) => (
              <div
                key={code}
                className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5"
              >
                <span className="text-[12px] text-muted">{REJECTION_LABELS[code]}</span>
                <span className="tnum text-[12px] text-dim">{n}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            Every rejection is logged with the rule that fired and the values it
            compared. Tuning a threshold on the Control screen changes these
            counts immediately — which is the intended way to find out whether a
            limit is doing useful work or just blocking everything.
          </p>
        </Panel>
      )}
    </div>
  );
}

function OpportunityTable({ rows }: { rows: ScoredOpportunity[] }) {
  if (rows.length === 0) {
    return (
      <div className="p-4 text-[12px] text-dim">
        No opportunities match this filter.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line">
            <Th>ST</Th>
            <Th>SLEEVE</Th>
            <Th>ASSET</Th>
            <Th>ROUTE</Th>
            <Th right>FUNDING APR</Th>
            <Th right>GROSS</Th>
            <Th right>FEES</Th>
            <Th right>SPREAD</Th>
            <Th right>SLIP</Th>
            <Th right>NET</Th>
            <Th right>NET APR</Th>
            <Th right>B/E</Th>
            <Th right>CAPITAL</Th>
            <Th>DECISION</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className="border-b border-line/60 hover:bg-raised/40">
              <Td>
                <span className="micro text-accent" title={o.strategyName}>
                  {o.strategy}
                </span>
              </Td>
              <Td>
                <span className="text-dim">{o.sleeveName}</span>
              </Td>
              <Td>
                <span className="text-ink">{o.asset}</span>
              </Td>
              <Td>
                <span className="text-dim">{o.route}</span>
              </Td>
              <Td right>
                {o.fundingApr === undefined ? (
                  <Dash />
                ) : (
                  <span className={cx("tnum", o.fundingApr >= 0 ? "text-up" : "text-down")}>
                    {(o.fundingApr * 100).toFixed(2)}%
                  </span>
                )}
              </Td>
              <Td right>
                <span className="tnum text-muted">{o.grossBps.toFixed(1)}</span>
              </Td>
              <Td right>
                <span className="tnum text-down/80">−{o.feesBps.toFixed(1)}</span>
              </Td>
              <Td right>
                <span className="tnum text-down/80">−{o.spreadBps.toFixed(1)}</span>
              </Td>
              <Td right>
                <span className="tnum text-down/80">−{o.slippageBps.toFixed(1)}</span>
              </Td>
              <Td right>
                <span
                  className={cx(
                    "tnum font-medium",
                    o.netBps > 0 ? "text-up" : o.netBps < 0 ? "text-down" : "text-muted",
                  )}
                >
                  {o.netBps > 0 ? "+" : ""}
                  {o.netBps.toFixed(1)}
                </span>
              </Td>
              <Td right>
                {o.netApr === null ? (
                  <Dash />
                ) : (
                  <span className={cx("tnum", o.netApr >= 0 ? "text-up" : "text-down")}>
                    {(o.netApr * 100).toFixed(1)}%
                  </span>
                )}
              </Td>
              <Td right>
                {o.breakevenDays === null ? (
                  <span className="text-dim" title="Never breaks even at this funding rate">
                    ∞
                  </span>
                ) : (
                  <span className="tnum text-muted">{o.breakevenDays.toFixed(1)}d</span>
                )}
              </Td>
              <Td right>
                <Money usd={o.capitalRequiredUsd} dp={0} className="text-muted" />
              </Td>
              <Td>
                {o.wouldTake ? (
                  <Tag tone="up">WOULD TAKE</Tag>
                ) : (
                  <span
                    className="text-dim"
                    title={o.rejectionDetail ?? undefined}
                  >
                    {o.rejectionCode ? REJECTION_LABELS[o.rejectionCode] : "—"}
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
        All edge figures are basis points of leg notional over the configured
        expected hold. Hover any rejection for the exact values compared. B/E is
        the number of days of funding needed to repay the round-trip cost — a
        position whose breakeven exceeds its expected hold is a guaranteed loss
        however attractive its annualised headline looks.
      </p>
    </div>
  );
}

function Dash() {
  return <span className="text-dim">—</span>;
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
