"use client";

/**
 * Positions — the paper book.
 *
 * Leads with delta exposure by underlying, because that is the number that
 * proves a "delta-neutral" strategy actually is. A carry holding +1 BTC spot
 * and −1 BTC perp nets to zero here; if it does not, the hedge has slipped and
 * the position is quietly directional while still being labelled neutral.
 *
 * Everything on this screen is simulated. That is stated in a banner rather
 * than left to context — a positions screen that does not say whether it is
 * real is the worst kind of ambiguous.
 */

import { useCallback, useState } from "react";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import { SLEEVES } from "@/lib/portfolio/sleeves";
import type { MarkedPosition, SleevePnl } from "@/lib/portfolio/positions";
import { cx, Micro, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type PositionsResponse = {
  mode: string;
  isLive: boolean;
  positions: MarkedPosition[];
  open: number;
  sleeves: SleevePnl[];
  delta: { asset: string; qty: number; usd: number }[];
  totals: {
    realisedUsd: number;
    fundingUsd: number;
    feesUsd: number;
    unrealisedUsd: number | null;
    grossExposureUsd: number | null;
    netExposureUsd: number | null;
  };
  fillCount: number;
};

type PaperRunResponse = {
  executed: number;
  rejected: number;
  candidates: number;
  scored: number;
  accuracy: {
    strategy: string;
    samples: number;
    meanPredictedNetBps: number;
    meanPredictedCostBps: number;
    meanRealisedCostBps: number;
    meanErrorBps: number;
  }[];
  decisions: {
    opportunityId: string;
    asset: string;
    strategy: string;
    executed: boolean;
    detail: string | null;
    rejectionCode: string | null;
  }[];
};

export default function PositionsPage() {
  const data = useLive<PositionsResponse>("/api/positions", 20_000);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<PaperRunResponse | null>(null);

  const run = useCallback(
    async (action?: "reset") => {
      setBusy(true);
      try {
        const r = await fetch("/api/paper", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(action ? { action } : {}),
        });
        const d = (await r.json()) as PaperRunResponse;
        setLastRun(action ? null : d);
        data.refresh();
      } finally {
        setBusy(false);
      }
    },
    [data],
  );

  const d = data.data;
  const totals = d?.totals;
  const open = d?.positions.filter((p) => p.qty !== 0) ?? [];

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2 border border-accent/25 bg-accent/5 px-3 py-2.5">
        <Tag tone="accent">PAPER</Tag>
        <span className="text-[12px] text-muted">
          Simulated fills against live market data, priced with the same cost
          model the scanner uses. No order here can reach an exchange.
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => run()}
            disabled={busy}
            className="micro border border-accent/50 bg-accent/10 px-2 py-1 text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          >
            {busy ? "RUNNING…" : "RUN PASS"}
          </button>
          <button
            onClick={() => run("reset")}
            disabled={busy}
            className="micro border border-line-bright px-2 py-1 text-dim transition-colors hover:text-muted disabled:opacity-40"
          >
            RESET BOOK
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------------- totals */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Panel>
          <Stat label="OPEN" sub={<span className="text-dim">positions</span>}>
            <span className="tnum text-[19px] text-ink">{open.length}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="REALISED" sub={<span className="text-dim">booked</span>}>
            <span
              className={cx(
                (totals?.realisedUsd ?? 0) > 0
                  ? "text-up"
                  : (totals?.realisedUsd ?? 0) < 0
                    ? "text-down"
                    : "text-muted",
              )}
            >
              <Money usd={totals?.realisedUsd ?? 0} />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="UNREALISED" sub={<span className="text-dim">marked</span>}>
            {totals?.unrealisedUsd === null || totals?.unrealisedUsd === undefined ? (
              <span className="text-[19px] text-dim">—</span>
            ) : (
              <span className={totals.unrealisedUsd >= 0 ? "text-up" : "text-down"}>
                <Money usd={totals.unrealisedUsd} />
              </span>
            )}
          </Stat>
        </Panel>
        <Panel>
          <Stat label="FUNDING" sub={<span className="text-dim">accrued</span>}>
            <span className="text-muted">
              <Money usd={totals?.fundingUsd ?? 0} />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="FEES" sub={<span className="text-dim">paid</span>}>
            <span className="text-down">
              <Money usd={totals?.feesUsd ?? 0} />
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="GROSS EXPOSURE" sub={<span className="text-dim">both sides</span>}>
            {totals?.grossExposureUsd === null || totals?.grossExposureUsd === undefined ? (
              <span className="text-[19px] text-dim">—</span>
            ) : (
              <Money usd={totals.grossExposureUsd} />
            )}
          </Stat>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1.2fr]">
        {/* -------------------------------------------------------- delta */}
        <Panel
          label="DELTA BY UNDERLYING"
          hint="PROVES NEUTRAL STRATEGIES ARE NEUTRAL"
          flush
        >
          {!d || d.delta.length === 0 ? (
            <div className="p-4 text-[12px] text-dim">
              No exposure. A delta-neutral carry nets to zero here, which is the
              point — a non-zero reading means the hedge has slipped.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-line">
                    <Th>ASSET</Th>
                    <Th right>NET QTY</Th>
                    <Th right>NET USD</Th>
                    <Th right>STATE</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.delta.map((x) => {
                    // Anything under a dollar of net exposure on a hedged pair
                    // is rounding, not a directional bet.
                    const neutral = Math.abs(x.usd) < 1;
                    return (
                      <tr key={x.asset} className="border-b border-line/60">
                        <Td>
                          <span className="text-ink">{x.asset}</span>
                        </Td>
                        <Td right>
                          <span className="tnum">{x.qty.toFixed(6)}</span>
                        </Td>
                        <Td right>
                          <span className={neutral ? "text-muted" : "text-warn"}>
                            <Money usd={x.usd} sign />
                          </span>
                        </Td>
                        <Td right>
                          <span className={cx("micro", neutral ? "text-up" : "text-warn")}>
                            {neutral ? "NEUTRAL" : "DIRECTIONAL"}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ------------------------------------------------------- sleeves */}
        <Panel label="PNL BY SLEEVE" hint="WHAT MAKES SLEEVE LIMITS ENFORCEABLE" flush>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>SLEEVE</Th>
                  <Th right>OPEN</Th>
                  <Th right>REALISED</Th>
                  <Th right>UNREALISED</Th>
                  <Th right>FEES</Th>
                  <Th right>TOTAL</Th>
                </tr>
              </thead>
              <tbody>
                {SLEEVES.map((def) => {
                  const s = d?.sleeves.find((x) => x.sleeveId === def.id);
                  return (
                    <tr key={def.id} className="border-b border-line/60">
                      <Td>
                        <span className="text-ink">{def.name}</span>
                      </Td>
                      <Td right>
                        <span className="tnum">{s?.openPositions ?? 0}</span>
                      </Td>
                      <Td right>
                        <Money usd={s?.realisedUsd ?? 0} />
                      </Td>
                      <Td right>
                        {s?.unrealisedUsd === null || s?.unrealisedUsd === undefined ? (
                          <span className="text-dim">—</span>
                        ) : (
                          <span className={s.unrealisedUsd >= 0 ? "text-up" : "text-down"}>
                            <Money usd={s.unrealisedUsd} />
                          </span>
                        )}
                      </Td>
                      <Td right>
                        <span className="text-down/80">
                          <Money usd={s?.feesUsd ?? 0} />
                        </span>
                      </Td>
                      <Td right>
                        {s?.totalUsd === null || s?.totalUsd === undefined ? (
                          <span className="text-dim">—</span>
                        ) : (
                          <span className={s.totalUsd >= 0 ? "text-up" : "text-down"}>
                            <Money usd={s.totalUsd} sign />
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------------ last pass result */}
      {lastRun && (
        <Panel
          label="LAST PAPER PASS"
          hint="PREDICTED VS REALISED — THE KEY DIAGNOSTIC"
          right={
            <Tag tone={lastRun.executed > 0 ? "up" : "neutral"}>
              {lastRun.executed} EXECUTED · {lastRun.rejected} REJECTED
            </Tag>
          }
        >
          {lastRun.accuracy.length > 0 ? (
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {lastRun.accuracy.map((a) => (
                <div key={a.strategy}>
                  <Micro className="mb-1.5">
                    {a.strategy} · {a.samples} SAMPLE{a.samples === 1 ? "" : "S"}
                  </Micro>
                  <div className="space-y-1 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-dim">Predicted entry cost</span>
                      <span className="tnum text-muted">
                        {a.meanPredictedCostBps.toFixed(1)}bp
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Realised entry cost</span>
                      <span className="tnum text-muted">
                        {a.meanRealisedCostBps.toFixed(1)}bp
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Predicted net edge</span>
                      <span className="tnum text-dim">
                        {a.meanPredictedNetBps.toFixed(1)}bp
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-line pt-1">
                      <span className="text-dim">Error</span>
                      <span
                        className={cx(
                          "tnum",
                          a.meanErrorBps > 0 ? "text-down" : "text-up",
                        )}
                      >
                        {a.meanErrorBps > 0 ? "+" : ""}
                        {a.meanErrorBps.toFixed(1)}bp
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-4 text-[11px] text-dim">
              Nothing executed, so there is no realised cost to compare against.
            </p>
          )}

          <Micro className="mb-2">
            {lastRun.candidates} CANDIDATE{lastRun.candidates === 1 ? "" : "S"} OF{" "}
            {lastRun.scored} SCORED
          </Micro>
          <ul className="space-y-1.5">
            {lastRun.decisions.slice(0, 10).map((x) => (
              <li key={x.opportunityId} className="flex items-start gap-2 text-[11.5px]">
                <StatusDot state={x.executed ? "ok" : "idle"} />
                <span className="text-ink">{x.asset}</span>
                <span className="text-dim">{x.strategy}</span>
                <span className="text-dim">{x.detail ?? x.rejectionCode ?? "executed"}</span>
              </li>
            ))}
          </ul>

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            Error is realised entry cost minus <em>predicted</em> entry cost —
            like for like. A positive error means the cost model is optimistic,
            so every threshold derived from it is too loose. That divergence, not
            the PnL, is what paper trading is for.
          </p>
        </Panel>
      )}

      {/* ------------------------------------------------------- positions */}
      <Panel
        label="OPEN POSITIONS"
        hint={d ? `${d.fillCount} FILLS RECORDED` : ""}
        flush
      >
        {open.length === 0 ? (
          <div className="p-4 text-[12px] text-dim">
            No open positions. Run a paper pass to execute whatever the scanner
            currently considers viable.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>SLEEVE</Th>
                  <Th>VENUE</Th>
                  <Th>ASSET</Th>
                  <Th>MKT</Th>
                  <Th right>QTY</Th>
                  <Th right>ENTRY</Th>
                  <Th right>MARK</Th>
                  <Th right>UNREALISED</Th>
                  <Th right>FUNDING</Th>
                  <Th right>FEES</Th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => (
                  <tr key={p.key} className="border-b border-line/60 hover:bg-raised/40">
                    <Td>{p.sleeveId}</Td>
                    <Td>{p.venue}</Td>
                    <Td>
                      <span className="text-ink">{p.asset}</span>
                    </Td>
                    <Td>
                      <span className="micro text-dim">{p.market.toUpperCase()}</span>
                    </Td>
                    <Td right>
                      <span className={cx("tnum", p.qty > 0 ? "text-up" : "text-down")}>
                        {p.qty > 0 ? "+" : ""}
                        {p.qty.toFixed(6)}
                      </span>
                    </Td>
                    <Td right>
                      <Money usd={p.avgEntry} dp={p.avgEntry < 1 ? 5 : 2} />
                    </Td>
                    <Td right>
                      {p.markPrice === null ? (
                        <span className="text-dim">—</span>
                      ) : (
                        <Money usd={p.markPrice} dp={p.markPrice < 1 ? 5 : 2} />
                      )}
                    </Td>
                    <Td right>
                      {p.unrealisedUsd === null ? (
                        <span className="text-dim">—</span>
                      ) : (
                        <span className={p.unrealisedUsd >= 0 ? "text-up" : "text-down"}>
                          <Money usd={p.unrealisedUsd} sign />
                        </span>
                      )}
                    </Td>
                    <Td right>
                      <Money usd={p.fundingUsd} className="text-muted" />
                    </Td>
                    <Td right>
                      <span className="text-down/80">
                        <Money usd={p.feesUsd} />
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
              Spot and perp are held as separate positions on purpose. A carry is
              two positions netting to zero delta, not one flat position — and
              seeing both is what makes a slipped hedge visible.
            </p>
          </div>
        )}
      </Panel>
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
