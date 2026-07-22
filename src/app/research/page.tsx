"use client";

/**
 * Research — backtesting the strategy on real history.
 *
 * The live system trades once a day, so a real track record is months away.
 * This replays the actual Binance funding history through the same carry logic
 * to answer the only question that matters early — does the edge survive costs —
 * and it is deliberately honest when the answer is no.
 */

import { useCallback, useEffect, useState } from "react";
import { NavChart } from "@/components/charts";
import { cx, Micro, Panel, Stat, Tag } from "@/components/ui";

type Stats = {
  totalReturnPct: number;
  annualisedReturnPct: number;
  trades: number;
  wins: number;
  winRate: number;
  avgHoldIntervals: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  timeInMarket: number;
};

type BacktestResult = {
  periodDays: number;
  costFraction: number;
  portfolio: { equity: { t: number; cumReturn: number }[]; stats: Stats };
  byAsset: { asset: string; stats: Stats; points: number }[];
  caveats: string[];
};

const LOOKBACKS = [
  { label: "3M", points: 270 },
  { label: "6M", points: 540 },
  { label: "9M", points: 810 },
  { label: "MAX", points: 1000 },
];

export default function ResearchPage() {
  const [points, setPoints] = useState(540);
  const [data, setData] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (pts: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/backtest?points=${pts}`);
      const d = (await res.json()) as BacktestResult & { error?: string };
      if (d.error) setError(d.error);
      else setData(d);
    } catch {
      setError("Backtest request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetching from an external system on mount/param-change is the sanctioned
    // effect use; `load` only sets state after awaiting, and the initial
    // loading flag is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(points);
  }, [load, points]);

  const s = data?.portfolio.stats;
  const profitable = (s?.totalReturnPct ?? 0) > 0;

  return (
    <div className="space-y-3 p-3">
      <Panel
        label="FUNDING-CARRY BACKTEST"
        hint="L1 · REAL BINANCE HISTORY · SAME COST MODEL"
        right={
          <div className="flex items-center gap-1">
            {LOOKBACKS.map((l) => (
              <button
                key={l.label}
                onClick={() => setPoints(l.points)}
                aria-pressed={points === l.points}
                className={cx(
                  "micro border px-1.5 py-1 transition-colors -ml-px first:ml-0",
                  points === l.points
                    ? "border-accent/50 bg-accent/10 text-accent z-10"
                    : "border-line-bright text-dim hover:text-muted",
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        }
      >
        {loading && !data ? (
          <div className="text-[12px] text-dim">Replaying real funding history…</div>
        ) : error ? (
          <div className="text-[12px] text-down">{error}</div>
        ) : s && data ? (
          <>
            <div
              className={cx(
                "mb-4 flex flex-wrap items-center gap-2 border px-3 py-2.5",
                profitable ? "border-up/30 bg-up/5" : "border-down/30 bg-down/5",
              )}
            >
              <Tag tone={profitable ? "up" : "down"}>{profitable ? "PROFITABLE" : "LOSES MONEY"}</Tag>
              <span className="text-[12px] text-muted">
                Over the last {data.periodDays.toFixed(0)} days, harvesting single-venue
                funding carry on the majors — at a modelled{" "}
                {(data.costFraction * 100).toFixed(2)}% round-trip cost — would have
                returned{" "}
                <span className={cx("tnum", profitable ? "text-up" : "text-down")}>
                  {s.totalReturnPct >= 0 ? "+" : ""}
                  {(s.totalReturnPct * 100).toFixed(2)}%
                </span>{" "}
                on notional.
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-7">
              <Stat label="RETURN" sub={<span className="text-dim">on notional</span>}>
                <span className={cx("tnum text-[17px]", s.totalReturnPct >= 0 ? "text-up" : "text-down")}>
                  {s.totalReturnPct >= 0 ? "+" : ""}
                  {(s.totalReturnPct * 100).toFixed(2)}%
                </span>
              </Stat>
              <Stat label="ANNUALISED" sub={<span className="text-dim">extrapolated</span>}>
                <span className={cx("tnum text-[17px]", s.annualisedReturnPct >= 0 ? "text-up" : "text-down")}>
                  {s.annualisedReturnPct >= 0 ? "+" : ""}
                  {(s.annualisedReturnPct * 100).toFixed(1)}%
                </span>
              </Stat>
              <Stat label="TRADES" sub={<span className="text-dim">round trips</span>}>
                <span className="tnum text-[17px] text-ink">{s.trades}</span>
              </Stat>
              <Stat label="WIN RATE" sub={<span className="text-dim">{s.wins}W</span>}>
                <span className={cx("tnum text-[17px]", s.winRate >= 0.5 ? "text-up" : "text-muted")}>
                  {s.trades > 0 ? `${(s.winRate * 100).toFixed(0)}%` : "—"}
                </span>
              </Stat>
              <Stat label="MAX DD" sub={<span className="text-dim">on notional</span>}>
                <span className="tnum text-[17px] text-warn">
                  −{(s.maxDrawdownPct * 100).toFixed(2)}%
                </span>
              </Stat>
              <Stat label="SHARPE" sub={<span className="text-dim">annualised</span>}>
                <span className={cx("tnum text-[17px]", (s.sharpe ?? 0) >= 0 ? "text-up" : "text-down")}>
                  {s.sharpe === null ? "—" : s.sharpe.toFixed(2)}
                </span>
              </Stat>
              <Stat label="IN MARKET" sub={<span className="text-dim">of the period</span>}>
                <span className="tnum text-[17px] text-muted">{(s.timeInMarket * 100).toFixed(0)}%</span>
              </Stat>
            </div>

            {data.portfolio.equity.length > 1 && (
              <div className="mt-5 border-t border-line pt-4">
                <Micro className="mb-2">EQUITY CURVE · CUMULATIVE RETURN ON NOTIONAL</Micro>
                <NavChart
                  data={data.portfolio.equity.map((e) => ({
                    t: new Date(e.t).toISOString().slice(0, 10),
                    v: e.cumReturn * 100,
                  }))}
                />
              </div>
            )}
          </>
        ) : null}
      </Panel>

      {data && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr]">
          <Panel label="BY ASSET" hint="EACH MAJOR, SAME RULES" flush>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-line">
                    <th className="micro px-3 py-2 text-left font-normal text-dim">ASSET</th>
                    <th className="micro px-3 py-2 text-right font-normal text-dim">RETURN</th>
                    <th className="micro px-3 py-2 text-right font-normal text-dim">TRADES</th>
                    <th className="micro px-3 py-2 text-right font-normal text-dim">WIN</th>
                    <th className="micro px-3 py-2 text-right font-normal text-dim">IN MKT</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAsset.map((a) => (
                    <tr key={a.asset} className="border-b border-line/60">
                      <td className="px-3 py-2 text-ink">{a.asset}</td>
                      <td className={cx("tnum px-3 py-2 text-right", a.stats.totalReturnPct >= 0 ? "text-up" : "text-down")}>
                        {a.stats.totalReturnPct >= 0 ? "+" : ""}
                        {(a.stats.totalReturnPct * 100).toFixed(2)}%
                      </td>
                      <td className="tnum px-3 py-2 text-right text-muted">{a.stats.trades}</td>
                      <td className="tnum px-3 py-2 text-right text-muted">
                        {a.stats.trades > 0 ? `${(a.stats.winRate * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-dim">
                        {(a.stats.timeInMarket * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel label="WHAT THIS DOES — AND DOESN'T — CLAIM" hint="READ BEFORE TRUSTING A NUMBER">
            <ul className="space-y-2">
              {data.caveats.map((c) => (
                <li key={c} className="flex gap-2.5 text-[11.5px] leading-relaxed text-muted">
                  <span className="mt-1.5 size-1 shrink-0 bg-accent" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
              A backtester that flatters the strategy is worse than none. When the
              answer is that the edge does not survive costs, that is the finding —
              not a bug to tune away.
            </p>
          </Panel>
        </div>
      )}
    </div>
  );
}
