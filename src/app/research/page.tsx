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
import { useLive } from "@/lib/live";
import { cx, Micro, Panel, Stat, Tag } from "@/components/ui";

type MlResponse = {
  points: number;
  assets: number;
  walkForward: {
    samples: number;
    testedSamples: number;
    baseRate: number;
    accuracy: number;
    baselineAccuracy: number;
    precisionAt70: number;
    coverageAt70: number;
    baselinePrecision: number;
    baselineCoverage: number;
    brier: number;
    beatsBaseline: boolean;
  };
  current: { asset: string; probability: number | null; medianRuleSaysHold: boolean }[];
  weights: { name: string; weight: number }[];
  caveats: string[];
  error?: string;
};

type FxResult = {
  periodDays: number;
  trend: {
    portfolio: Stats;
    priceReturn: number;
    carryReturn: number;
    pairs: { symbol: string; stats: Stats; extra: { priceReturn: number; carryReturn: number; exits: { flip: number; stop: number } } }[];
    sensitivity: { fast: number; slow: number; minStrengthPct: number; totalReturnPct: number; trades: number }[];
    liveParams: { fast: number; slow: number; minStrengthPct: number };
  };
  carry: {
    portfolio: Stats;
    priceReturn: number;
    carryReturn: number;
    pairs: { symbol: string; stats: Stats; extra: { direction: number; netCarryApr: number; priceReturn: number; carryReturn: number; stops: number } }[];
  };
  caveats: string[];
  error?: string;
};

type SpreadResult = {
  periodDays: number;
  costFraction: number;
  pairs: { asset: string; venues: string; intervals: number; stats: Stats }[];
  sweep: { exitSpreadApr: number; stats: Stats; trades: number }[];
  bestExitSpreadApr: number | null;
  liveExitSpreadApr: number;
  caveats: string[];
  error?: string;
};

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
  scenarios?: { key: string; label: string; costFraction: number; stats: Stats }[];
  entrySweep?: {
    minFundingApr: number;
    minNetEdgeBps: number;
    liquidity: "taker" | "maker";
    totalReturnPct: number;
    trades: number;
    winRate: number;
  }[];
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

      {data?.scenarios && data.scenarios.length > 0 && (
        <Panel
          label="EXECUTION LEVERS"
          hint="SAME HISTORY · ENTRY LIQUIDITY × EXIT RULE"
          flush
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="micro px-3 py-2 text-left font-normal text-dim">SCENARIO</th>
                  <th className="micro px-3 py-2 text-right font-normal text-dim">COST</th>
                  <th className="micro px-3 py-2 text-right font-normal text-dim">RETURN</th>
                  <th className="micro px-3 py-2 text-right font-normal text-dim">ANNUALISED</th>
                  <th className="micro px-3 py-2 text-right font-normal text-dim">TRADES</th>
                  <th className="micro px-3 py-2 text-right font-normal text-dim">WIN</th>
                </tr>
              </thead>
              <tbody>
                {data.scenarios.map((sc) => (
                  <tr
                    key={sc.key}
                    className={cx(
                      "border-b border-line/60",
                      sc.key === "taker-regime" && "bg-raised/30",
                    )}
                  >
                    <td className="px-3 py-2 text-ink">
                      {sc.label}
                      {sc.key === "taker-regime" && (
                        <span className="micro ml-2 text-accent">CURRENT</span>
                      )}
                    </td>
                    <td className="tnum px-3 py-2 text-right text-muted">
                      {(sc.costFraction * 100).toFixed(3)}%
                    </td>
                    <td
                      className={cx(
                        "tnum px-3 py-2 text-right",
                        sc.stats.totalReturnPct >= 0 ? "text-up" : "text-down",
                      )}
                    >
                      {sc.stats.totalReturnPct >= 0 ? "+" : ""}
                      {(sc.stats.totalReturnPct * 100).toFixed(2)}%
                    </td>
                    <td
                      className={cx(
                        "tnum px-3 py-2 text-right",
                        sc.stats.annualisedReturnPct >= 0 ? "text-up" : "text-down",
                      )}
                    >
                      {sc.stats.annualisedReturnPct >= 0 ? "+" : ""}
                      {(sc.stats.annualisedReturnPct * 100).toFixed(1)}%
                    </td>
                    <td className="tnum px-3 py-2 text-right text-muted">{sc.stats.trades}</td>
                    <td className="tnum px-3 py-2 text-right text-muted">
                      {sc.stats.trades > 0 ? `${(sc.stats.winRate * 100).toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
              The two levers actually available without new capital: resting
              post-only entries instead of crossing the spread, and exiting on a
              broken regime instead of a single negative print. Maker rows assume
              every entry fills at the touch — the optimistic bound.
            </p>

            {data.entrySweep && data.entrySweep.length > 0 && (
              <div className="border-t border-line px-3 py-3">
                <Micro className="mb-2">
                  ENTRY-GATE SWEEP · FUNDING FLOOR × EDGE FLOOR · REGIME EXIT
                </Micro>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {(["taker", "maker"] as const).map((liq) => (
                    <div key={liq}>
                      <div className="micro mb-1.5 text-dim">{liq.toUpperCase()} COST</div>
                      <table className="w-full text-[11.5px]">
                        <thead>
                          <tr className="border-b border-line">
                            <Th>FLOOR</Th>
                            <Th right>5BP</Th>
                            <Th right>15BP</Th>
                            <Th right>30BP</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {[0.05, 0.08, 0.12, 0.2].map((floor) => {
                            const cells = data
                              .entrySweep!.filter(
                                (c) => c.liquidity === liq && c.minFundingApr === floor,
                              )
                              .sort((a, b) => a.minNetEdgeBps - b.minNetEdgeBps);
                            if (cells.length === 0) return null;
                            const isLive = floor === 0.08;
                            return (
                              <tr key={floor} className="border-b border-line/60">
                                <Td>
                                  <span className="tnum text-ink">{(floor * 100).toFixed(0)}%</span>
                                  {isLive && <span className="micro ml-1.5 text-accent">LIVE</span>}
                                </Td>
                                {cells.map((c) => (
                                  <Td key={c.minNetEdgeBps} right>
                                    <span
                                      className={cx(
                                        "tnum",
                                        c.trades === 0
                                          ? "text-dim"
                                          : c.totalReturnPct > 0
                                            ? "text-up"
                                            : "text-down",
                                      )}
                                      title={`${c.trades} trades`}
                                    >
                                      {c.totalReturnPct >= 0 ? "+" : ""}
                                      {(c.totalReturnPct * 100).toFixed(2)}%
                                    </span>
                                  </Td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-dim">
                  At taker cost the whole grid is flat — there is no parameter
                  setting that makes L1 pay; the live cell is representative, not
                  mis-tuned. At maker cost a stable positive plateau covers the
                  5–8% floors at every edge setting, and the live operating point
                  sits inside it: the binding lever is execution style, not
                  parameters. Dim cells took zero trades.
                </p>
              </div>
            )}
          </div>
        </Panel>
      )}

      <SpreadPanel />
      <FxPanel />
      <MlPanel />

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

function MlPanel() {
  // Trains and validates on demand server-side; slow-polled because history
  // moves one funding interval every 8 hours.
  const { data, status } = useLive<MlResponse>("/api/ml", 300_000);
  const wf = data?.walkForward;

  return (
    <Panel
      label="FUNDING PERSISTENCE MODEL"
      hint="FIRST ML · WALK-FORWARD ON REAL HISTORY · SHADOW"
    >
      {!data && (
        <div className="text-[12px] text-dim">
          {status === "error"
            ? "Model validation unavailable"
            : "Training and validating on real funding history…"}
        </div>
      )}
      {data?.error && <div className="text-[12px] text-down">{data.error}</div>}
      {wf && data && (
        <>
          <div
            className={cx(
              "mb-4 flex flex-wrap items-center gap-2 border px-3 py-2.5",
              wf.beatsBaseline ? "border-up/30 bg-up/5" : "border-warn/30 bg-warn/5",
            )}
          >
            <Tag tone={wf.beatsBaseline ? "up" : "warn"}>
              {wf.beatsBaseline ? "BEATS BASELINE" : "NOT BETTER THAN BASELINE"}
            </Tag>
            <span className="text-[12px] text-muted">
              Out of sample over {wf.testedSamples.toLocaleString("en-US")} unseen
              windows: when the model is ≥70% confident funding persists, it is
              right{" "}
              <span className="tnum text-ink">{(wf.precisionAt70 * 100).toFixed(1)}%</span>{" "}
              of the time, vs{" "}
              <span className="tnum">{(wf.baselinePrecision * 100).toFixed(1)}%</span>{" "}
              for the naive median rule the exits use today.
              {!wf.beatsBaseline && " The baseline stays in charge until this flips."}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label="SAMPLES" sub={<span className="text-dim">{data.assets} assets pooled</span>}>
              <span className="tnum text-[17px] text-ink">
                {wf.samples.toLocaleString("en-US")}
              </span>
            </Stat>
            <Stat label="ACCURACY" sub={<span className="text-dim">baseline {(wf.baselineAccuracy * 100).toFixed(1)}%</span>}>
              <span className={cx("tnum text-[17px]", wf.accuracy >= wf.baselineAccuracy ? "text-up" : "text-warn")}>
                {(wf.accuracy * 100).toFixed(1)}%
              </span>
            </Stat>
            <Stat label="PRECISION ≥70%" sub={<span className="text-dim">baseline {(wf.baselinePrecision * 100).toFixed(1)}%</span>}>
              <span className={cx("tnum text-[17px]", wf.precisionAt70 >= wf.baselinePrecision ? "text-up" : "text-warn")}>
                {(wf.precisionAt70 * 100).toFixed(1)}%
              </span>
            </Stat>
            <Stat label="COVERAGE ≥70%" sub={<span className="text-dim">how often it commits</span>}>
              <span className="tnum text-[17px] text-muted">
                {(wf.coverageAt70 * 100).toFixed(0)}%
              </span>
            </Stat>
            <Stat label="BRIER" sub={<span className="text-dim">calibration, lower better</span>}>
              <span className="tnum text-[17px] text-muted">{wf.brier.toFixed(3)}</span>
            </Stat>
            <Stat label="BASE RATE" sub={<span className="text-dim">funding persisted</span>}>
              <span className="tnum text-[17px] text-dim">{(wf.baseRate * 100).toFixed(0)}%</span>
            </Stat>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 border-t border-line pt-4 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <Micro className="mb-2">CURRENT REGIME · P(FUNDING PERSISTS 7D)</Micro>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                {data.current.map((c) => (
                  <div key={c.asset} className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] text-muted">{c.asset}</span>
                    <span
                      className={cx(
                        "tnum text-[13px]",
                        c.probability === null
                          ? "text-dim"
                          : c.probability >= 0.7
                            ? "text-up"
                            : c.probability >= 0.5
                              ? "text-warn"
                              : "text-down",
                      )}
                    >
                      {c.probability === null ? "—" : `${(c.probability * 100).toFixed(0)}%`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <Micro className="mb-2">WHAT THE MODEL LEARNED</Micro>
              <div className="space-y-1.5">
                {data.weights.map((w) => (
                  <div key={w.name} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-[11px] text-muted">{w.name}</span>
                    <div className="relative h-[3px] flex-1 bg-raised">
                      <div
                        className={cx("absolute h-full", w.weight >= 0 ? "bg-up" : "bg-down")}
                        style={{
                          width: `${Math.min(Math.abs(w.weight) * 60, 100)}%`,
                          left: w.weight >= 0 ? "50%" : undefined,
                          right: w.weight < 0 ? "50%" : undefined,
                        }}
                      />
                      <div className="absolute left-1/2 top-[-2px] h-[7px] w-px bg-line-bright" />
                    </div>
                    <span className="tnum w-12 shrink-0 text-right text-[11px] text-dim">
                      {w.weight >= 0 ? "+" : ""}
                      {w.weight.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            {data.caveats.join(" ")}
          </p>
        </>
      )}
    </Panel>
  );
}

function SpreadPanel() {
  // Pulls three venues and replays every pair, so it is slow and slow-polled.
  const { data, status } = useLive<SpreadResult>("/api/backtest/spread", 600_000);

  const best = data?.sweep?.reduce(
    (b, s) => (b === null || s.stats.totalReturnPct > b.stats.totalReturnPct ? s : b),
    null as SpreadResult["sweep"][number] | null,
  );
  // The honest verdict: profitable at ANY tested exit band, or not at all.
  const anyProfitable = (best?.stats.totalReturnPct ?? 0) > 0;

  return (
    <Panel
      label="CROSS-VENUE SPREAD BACKTEST"
      hint="L2 · BINANCE ⇄ BYBIT ⇄ OKX · EXIT-BAND SWEEP"
    >
      {!data && (
        <div className="text-[12px] text-dim">
          {status === "error"
            ? "Spread backtest unavailable"
            : "Replaying three venues of real funding history…"}
        </div>
      )}
      {data?.error && <div className="text-[12px] text-down">{data.error}</div>}
      {data && !data.error && data.sweep.length > 0 && (
        <>
          <div
            className={cx(
              "mb-4 flex flex-wrap items-center gap-2 border px-3 py-2.5",
              anyProfitable ? "border-up/30 bg-up/5" : "border-down/30 bg-down/5",
            )}
          >
            <Tag tone={anyProfitable ? "up" : "down"}>
              {anyProfitable ? "TRADEABLE" : "NOT TRADEABLE AT RETAIL COST"}
            </Tag>
            <span className="text-[12px] text-muted">
              Over {data.periodDays.toFixed(0)} days across {data.pairs.length} venue
              pairs, the cross-venue spread lost money at{" "}
              <span className="tnum">every</span> exit band tested — best case{" "}
              <span className={cx("tnum", anyProfitable ? "text-up" : "text-down")}>
                {((best?.stats.totalReturnPct ?? 0) * 100).toFixed(2)}%
              </span>{" "}
              on notional. The spread mean-reverts within a day while a round trip
              costs {(data.costFraction * 100).toFixed(2)}%, so the trade cannot
              amortise its own entry. L2 is scored and shown, but no longer sized
              on the 21-day carry hold that made it look profitable.
            </span>
          </div>

          <Micro className="mb-2">EXIT-BAND SWEEP · WIDER BAND = FEWER ROUND TRIPS</Micro>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>EXIT BAND</Th>
                  <Th right>RETURN</Th>
                  <Th right>ANNUALISED</Th>
                  <Th right>ROUND TRIPS</Th>
                  <Th right>WIN</Th>
                  <Th right>IN MKT</Th>
                </tr>
              </thead>
              <tbody>
                {data.sweep.map((s) => (
                  <tr
                    key={s.exitSpreadApr}
                    className={cx(
                      "border-b border-line/60",
                      s.exitSpreadApr === data.liveExitSpreadApr && "bg-raised/30",
                    )}
                  >
                    <Td>
                      <span className="tnum text-ink">
                        {(s.exitSpreadApr * 100).toFixed(1)}%
                      </span>
                      {s.exitSpreadApr === data.liveExitSpreadApr && (
                        <span className="micro ml-2 text-accent">LIVE</span>
                      )}
                    </Td>
                    <Td right>
                      <span
                        className={cx(
                          "tnum",
                          s.stats.totalReturnPct >= 0 ? "text-up" : "text-down",
                        )}
                      >
                        {s.stats.totalReturnPct >= 0 ? "+" : ""}
                        {(s.stats.totalReturnPct * 100).toFixed(2)}%
                      </span>
                    </Td>
                    <Td right>
                      <span
                        className={cx(
                          "tnum",
                          s.stats.annualisedReturnPct >= 0 ? "text-up" : "text-down",
                        )}
                      >
                        {(s.stats.annualisedReturnPct * 100).toFixed(1)}%
                      </span>
                    </Td>
                    <Td right>
                      <span className="tnum text-muted">{s.trades}</span>
                    </Td>
                    <Td right>
                      <span className="tnum text-muted">
                        {(s.stats.winRate * 100).toFixed(0)}%
                      </span>
                    </Td>
                    <Td right>
                      <span className="tnum text-dim">
                        {(s.stats.timeInMarket * 100).toFixed(0)}%
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            Returns improve only as the band widens because a wider band trades
            less — the sweep is measuring how much the churn costs, not finding a
            profitable setting. {data.caveats.join(" ")}
          </p>
        </>
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

function FxPanel() {
  // Three years of daily fixes across seven pairs — slow, slow-polled.
  const { data, status } = useLive<FxResult>("/api/backtest/fx", 600_000);

  const pct = (x: number, dp = 2) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp)}%`;

  return (
    <Panel
      label="FX BOOK BACKTEST"
      hint="F1 CARRY + F2 TREND · 3Y OF ECB DAILY FIXES · LIVE SIGNAL CODE"
    >
      {!data && (
        <div className="text-[12px] text-dim">
          {status === "error"
            ? "FX backtest unavailable"
            : "Replaying three years of FX history through the live signals…"}
        </div>
      )}
      {data?.error && <div className="text-[12px] text-down">{data.error}</div>}
      {data && !data.error && (
        <>
          {/* F2 verdict */}
          <div className="mb-3 flex flex-wrap items-center gap-2 border border-down/30 bg-down/5 px-3 py-2.5">
            <Tag tone="down">F2 TREND · NOT TRADEABLE</Tag>
            <span className="text-[12px] text-muted">
              Dual-MA trend following lost{" "}
              <span className="tnum text-down">{pct(data.trend.portfolio.totalReturnPct)}</span>{" "}
              over ~{data.periodDays} days with a {(data.trend.portfolio.winRate * 100).toFixed(0)}%
              win rate — and every cell of the parameter grid below is negative, so this is
              the strategy failing, not a parameter choice. It is also structurally
              short-carry ({pct(data.trend.carryReturn)} carry drag): its winners are the
              high-carry pairs where pure carry earned several times more.
            </span>
          </div>

          {/* F1 verdict */}
          <div className="mb-4 flex flex-wrap items-center gap-2 border border-up/30 bg-up/5 px-3 py-2.5">
            <Tag tone="up">F1 CARRY · EARNS</Tag>
            <span className="text-[12px] text-muted">
              Holding the differential-earning direction returned{" "}
              <span className="tnum text-up">{pct(data.carry.portfolio.totalReturnPct)}</span>{" "}
              (Sharpe {data.carry.portfolio.sharpe?.toFixed(2) ?? "—"}, max drawdown{" "}
              {(data.carry.portfolio.maxDrawdownPct * 100).toFixed(1)}%), with BOTH components
              positive: carry {pct(data.carry.carryReturn)} and price {pct(data.carry.priceReturn)}.
              Only {data.carry.pairs.filter((p) => p.extra.direction !== 0).length} of{" "}
              {data.carry.pairs.length} pairs clear the net-carry floor — the book is
              concentrated, not diversified.
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <Micro className="mb-2">
                F2 SENSITIVITY · PORTFOLIO RETURN BY MA PAIR × STRENGTH FLOOR
              </Micro>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-line">
                      <Th>FAST/SLOW</Th>
                      <Th right>0.2%</Th>
                      <Th right>0.3%</Th>
                      <Th right>0.5%</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {[10, 20, 30, 40].map((fast) => {
                      const row = data.trend.sensitivity.filter((c) => c.fast === fast);
                      if (row.length === 0) return null;
                      const live = data.trend.liveParams;
                      return (
                        <tr key={fast} className="border-b border-line/60">
                          <Td>
                            <span className="tnum text-ink">
                              {fast}/{row[0].slow}
                            </span>
                            {fast === live.fast && (
                              <span className="micro ml-2 text-accent">LIVE</span>
                            )}
                          </Td>
                          {row.map((c) => (
                            <Td key={c.minStrengthPct} right>
                              <span
                                className={cx(
                                  "tnum",
                                  c.totalReturnPct >= 0 ? "text-up" : "text-down",
                                )}
                              >
                                {pct(c.totalReturnPct)}
                              </span>
                            </Td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <Micro className="mb-2">F1 BY PAIR · CARRY VS PRICE DECOMPOSITION</Micro>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-line">
                      <Th>PAIR</Th>
                      <Th right>TOTAL</Th>
                      <Th right>CARRY</Th>
                      <Th right>PRICE</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.carry.pairs
                      .filter((p) => p.extra.direction !== 0)
                      .map((p) => (
                        <tr key={p.symbol} className="border-b border-line/60">
                          <Td>
                            <span className="text-ink">{p.symbol}</span>
                            <span className="micro ml-2 text-dim">
                              {p.extra.direction === 1 ? "LONG" : "SHORT"}
                            </span>
                          </Td>
                          <Td right>
                            <span
                              className={cx(
                                "tnum",
                                p.stats.totalReturnPct >= 0 ? "text-up" : "text-down",
                              )}
                            >
                              {pct(p.stats.totalReturnPct)}
                            </span>
                          </Td>
                          <Td right>
                            <span className="tnum text-up">{pct(p.extra.carryReturn)}</span>
                          </Td>
                          <Td right>
                            <span
                              className={cx(
                                "tnum",
                                p.extra.priceReturn >= 0 ? "text-up" : "text-down",
                              )}
                            >
                              {pct(p.extra.priceReturn)}
                            </span>
                          </Td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-dim">
                The price column is history, not promise — the durable part of the
                carry trade is the carry column, at current policy rates.
              </p>
            </div>
          </div>

          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            {data.caveats.join(" ")}
          </p>
        </>
      )}
    </Panel>
  );
}
