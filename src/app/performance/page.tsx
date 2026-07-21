"use client";

/**
 * Performance — where the money came from, and what is stopping it.
 *
 * Deliberately answers four questions in order, and nothing else:
 *
 *   1. Is it working?          the index, and the NAV line
 *   2. Where is it working?    P&L by strategy, venue and asset
 *   3. What is blocking it?    the binding constraint, ranked
 *   4. Is the model honest?    predicted vs realised cost
 *
 * Question 3 is usually the most actionable and the easiest to skip. A system
 * that executes nothing is not broken by default — it may be correctly refusing
 * bad trades. The only way to tell is to look at which rule fired most.
 */

import { useState } from "react";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import type {
  Attribution,
  BlockerSummary,
  CostAccuracy,
  PerformanceReport,
} from "@/lib/engine/performance";
import { cx, Micro, Panel, Stat, Tag } from "@/components/ui";

type Response = {
  report: PerformanceReport;
  nav: {
    navUsd: number;
    netContributedUsd: number;
    performanceIndex: number;
    twrPct: number;
    nature: string;
  };
  pnl: { realisedUsd: number; unrealisedUsd: number; fundingUsd: number; feesUsd: number; totalUsd: number };
};

type Dimension = "strategy" | "venue" | "asset" | "sleeve";

export default function PerformancePage() {
  const { data, status } = useLive<Response>("/api/performance", 30_000);
  const [dim, setDim] = useState<Dimension>("strategy");

  const r = data?.report;
  const nav = data?.nav;
  const act = r?.activity;

  const rows: Attribution[] =
    dim === "strategy"
      ? (r?.byStrategy ?? [])
      : dim === "venue"
        ? (r?.byVenue ?? [])
        : dim === "asset"
          ? (r?.byAsset ?? [])
          : (r?.bySleeve ?? []);

  return (
    <div className="space-y-3 p-3">
      {/* -------------------------------------------- 1 · is it working? */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Panel>
          <Stat label="PERFORMANCE" sub={<span className="text-dim">index, 1.0 at start</span>}>
            <span
              className={cx(
                "tnum text-[19px]",
                (nav?.performanceIndex ?? 1) >= 1 ? "text-up" : "text-down",
              )}
            >
              {(nav?.performanceIndex ?? 1).toFixed(5)}
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="RETURN" sub={<span className="text-dim">ignores deposits</span>}>
            <span
              className={cx("tnum text-[19px]", (nav?.twrPct ?? 0) >= 0 ? "text-up" : "text-down")}
            >
              {(nav?.twrPct ?? 0) >= 0 ? "+" : ""}
              {((nav?.twrPct ?? 0) * 100).toFixed(3)}%
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="NET P&L" sub={<span className="text-dim">after every cost</span>}>
            <span className={cx((data?.pnl.totalUsd ?? 0) >= 0 ? "text-up" : "text-down")}>
              <Money usd={data?.pnl.totalUsd ?? 0} sign />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="PASSES" sub={<span className="text-dim">decisions made</span>}>
            <span className="tnum text-[19px] text-ink">{act?.passes ?? 0}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="EXECUTIONS" sub={<span className="text-dim">of {act?.totalScored ?? 0} scored</span>}>
            <span className="tnum text-[19px] text-ink">{act?.totalExecutions ?? 0}</span>
          </Stat>
        </Panel>
      </div>

      {r && r.navSeries.length > 1 && <NavLine series={r.navSeries} />}

      {/* ------------------------------------------ 2 · where is it working? */}
      <Panel
        label="WHERE THE MONEY CAME FROM"
        hint="NET OF FEES AND FUNDING"
        right={
          <div className="flex items-center gap-1">
            {(["strategy", "venue", "asset", "sleeve"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDim(d)}
                className={cx(
                  "micro border px-1.5 py-1 -ml-px first:ml-0 transition-colors",
                  dim === d
                    ? "border-accent/50 bg-accent/10 text-accent z-10"
                    : "border-line-bright text-dim hover:text-muted",
                )}
              >
                {d.toUpperCase()}
              </button>
            ))}
          </div>
        }
        flush
      >
        {rows.length === 0 ? (
          <div className="p-4 text-[12px] text-dim">
            Nothing executed yet, so there is no attribution to show. The
            blockers below explain why.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>{dim.toUpperCase()}</Th>
                  <Th right>TRADES</Th>
                  <Th right>OPEN</Th>
                  <Th right>REALISED</Th>
                  <Th right>UNREALISED</Th>
                  <Th right>FUNDING</Th>
                  <Th right>FEES</Th>
                  <Th right>NET</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.key} className="border-b border-line/60 hover:bg-raised/40">
                    <Td>
                      <span className="text-ink">{a.key}</span>
                    </Td>
                    <Td right>
                      <span className="tnum">{a.trades}</span>
                    </Td>
                    <Td right>
                      <span className="tnum">{a.openPositions}</span>
                    </Td>
                    <Td right>
                      <Money usd={a.realisedUsd} sign />
                    </Td>
                    <Td right>
                      <span className={a.unrealisedUsd >= 0 ? "text-up" : "text-down"}>
                        <Money usd={a.unrealisedUsd} sign />
                      </span>
                    </Td>
                    <Td right>
                      <span className={a.fundingUsd > 0 ? "text-up" : "text-muted"}>
                        <Money usd={a.fundingUsd} sign />
                      </span>
                    </Td>
                    <Td right>
                      <span className="text-down/80">
                        −<Money usd={a.feesUsd} />
                      </span>
                    </Td>
                    <Td right>
                      <span
                        className={cx(
                          "font-medium",
                          a.totalUsd > 0 ? "text-up" : a.totalUsd < 0 ? "text-down" : "text-muted",
                        )}
                      >
                        <Money usd={a.totalUsd} sign />
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1fr]">
        {/* ------------------------------------- 3 · what is blocking it? */}
        <Blockers blockers={r?.blockers ?? []} />

        {/* ------------------------------------- 4 · is the model honest? */}
        <ModelAccuracy accuracy={r?.costAccuracy ?? []} />
      </div>

      <Panel label="ACTIVITY" hint="IS IT ACTUALLY RUNNING?">
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          <Stat label="FIRST PASS" sub={<span className="text-dim">UTC</span>}>
            <span className="tnum text-[13px] text-muted">
              {act?.firstPassTs
                ? new Date(act.firstPassTs).toISOString().replace("T", " ").slice(0, 16)
                : "—"}
            </span>
          </Stat>
          <Stat label="LAST PASS" sub={<span className="text-dim">UTC</span>}>
            <span className="tnum text-[13px] text-muted">
              {act?.lastPassTs
                ? new Date(act.lastPassTs).toISOString().replace("T", " ").slice(0, 16)
                : "—"}
            </span>
          </Stat>
          <Stat label="FEED" sub={<span className="text-dim">this page</span>}>
            <span className="text-[13px] text-muted">{status}</span>
          </Stat>
          <Stat label="CAPITAL" sub={<span className="text-dim">nature</span>}>
            <span className="text-[13px] text-muted">{nav?.nature ?? "—"}</span>
          </Stat>
        </div>

        {act && Object.keys(act.skipped).length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <Micro className="mb-2">PASSES THAT DID NOTHING</Micro>
            <ul className="space-y-1">
              {Object.entries(act.skipped).map(([reason, n]) => (
                <li key={reason} className="flex justify-between gap-3 text-[11.5px]">
                  <span className="text-muted">{reason}</span>
                  <span className="tnum text-dim">{n}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[11px] leading-relaxed text-dim">
              Recorded rather than left as a gap — &ldquo;halted&rdquo; and
              &ldquo;the machine was asleep&rdquo; look identical in a history
              that only logs what happened.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------- nav line */

function NavLine({ series }: { series: { ts: number; navUsd: number }[] }) {
  const W = 1000;
  const H = 90;
  const vals = series.map((s) => s.navUsd);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) || 1;
  const pad = span * 0.15;
  const min = lo - pad;
  const max = hi + pad;

  const d = series
    .map((s, i) => {
      const x = (i / Math.max(series.length - 1, 1)) * W;
      const y = (1 - (s.navUsd - min) / (max - min)) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const first = series[0].navUsd;
  const last = series[series.length - 1].navUsd;
  const up = last >= first;

  return (
    <Panel
      label="NAV"
      hint={`${series.length} PASSES`}
      right={
        <Tag tone={up ? "up" : "down"}>
          {up ? "+" : ""}
          {(last - first).toFixed(2)}
        </Tag>
      }
      flush
    >
      <div className="px-2 pb-2 pt-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} preserveAspectRatio="none">
          <path
            d={d}
            fill="none"
            stroke={up ? "var(--color-up)" : "var(--color-down)"}
            strokeWidth="1.5"
          />
        </svg>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- blockers */

function Blockers({ blockers }: { blockers: BlockerSummary[] }) {
  const top = blockers[0];

  return (
    <Panel label="WHAT IS STOPPING IT" hint="THE BINDING CONSTRAINT FIRST">
      {blockers.length === 0 ? (
        <p className="text-[11px] text-dim">
          No rejections recorded. Either nothing has been scanned yet, or
          everything scored was taken.
        </p>
      ) : (
        <>
          <div className="mb-4 border border-warn/25 bg-warn/5 px-3 py-2.5">
            <Micro className="mb-1">BINDING CONSTRAINT</Micro>
            <p className="text-[12.5px] text-ink">{top.label}</p>
            <p className="mt-1 text-[11px] text-dim">
              {(top.share * 100).toFixed(0)}% of all rejections. If this rule is
              wrong, it is costing you everything downstream of it — tuning
              anything else first is wasted effort.
            </p>
          </div>

          <ul className="space-y-2">
            {blockers.map((b) => (
              <li key={b.code}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[11.5px] text-muted">{b.label}</span>
                  <span className="tnum text-[11px] text-dim">{b.count}</span>
                </div>
                <div className="mt-1 h-[3px] w-full bg-raised">
                  <div
                    className="h-full bg-warn/70"
                    style={{ width: `${(b.share * 100).toFixed(1)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------- model accuracy */

function ModelAccuracy({ accuracy }: { accuracy: CostAccuracy[] }) {
  return (
    <Panel label="IS THE COST MODEL HONEST" hint="PREDICTED VS REALISED ENTRY COST">
      {accuracy.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-dim">
          No executions yet, so there is nothing to compare. This is the
          diagnostic that matters most once trades start: a persistent gap means
          the cost model is wrong, and every threshold derived from it is wrong
          with it.
        </p>
      ) : (
        <div className="space-y-4">
          {accuracy.map((a) => {
            const optimistic = a.meanErrorBps > 0.5;
            return (
              <div key={a.strategy}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-[12.5px] text-ink">{a.strategy}</span>
                  <span className="micro text-dim">{a.samples} SAMPLES</span>
                </div>
                <dl className="space-y-1 text-[11.5px]">
                  <div className="flex justify-between">
                    <dt className="text-dim">Predicted</dt>
                    <dd className="tnum text-muted">{a.meanPredictedCostBps.toFixed(2)}bp</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-dim">Realised</dt>
                    <dd className="tnum text-muted">{a.meanRealisedCostBps.toFixed(2)}bp</dd>
                  </div>
                  <div className="flex justify-between border-t border-line pt-1">
                    <dt className="text-dim">Error</dt>
                    <dd className={cx("tnum", optimistic ? "text-down" : "text-up")}>
                      {a.meanErrorBps >= 0 ? "+" : ""}
                      {a.meanErrorBps.toFixed(2)}bp
                    </dd>
                  </div>
                </dl>
                {optimistic && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-down">
                    Costing more than predicted — the model is optimistic, so the
                    edge thresholds are letting through trades that were never
                    viable.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
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
