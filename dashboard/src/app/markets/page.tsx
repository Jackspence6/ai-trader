"use client";

/**
 * Markets — live prices, funding and indicators across every venue.
 *
 * The purpose of this screen is to make the engine's decisions *inspectable*.
 * When the scanner says a carry is attractive on Bybit but not Binance, this is
 * where you see the funding difference that caused it. Every number the
 * strategies read is shown here, from the same source, at the same moment.
 *
 * Nothing here is simulated. Where a venue does not publish a field, the cell
 * shows a dash rather than a zero.
 */

import { useMemo, useState } from "react";
import { useLive } from "@/lib/live";
import { Money, useCurrency } from "@/lib/currency";
import { UNIVERSE, type MarketSnapshot, type Quote } from "@/lib/market/types";
import type { FxRates } from "@/lib/market/fx";
import { CandleChart, FundingChart, type Candle } from "@/components/price-chart";
import { cx, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type MarketsResponse = MarketSnapshot & { fx: FxRates };

type CandlesResponse = {
  asset: string;
  interval: string;
  candles: Candle[];
  series: {
    ema20: (number | null)[];
    ema50: (number | null)[];
    donchianUpper: (number | null)[];
    donchianLower: (number | null)[];
  };
  indicators: {
    price: number;
    ema20: number | null;
    ema50: number | null;
    rsi14: number | null;
    atr14: number | null;
    atrPct: number | null;
    realisedVol30d: number | null;
    realisedVol90d: number | null;
  };
  funding: {
    history: { t: number; rate: number; apr: number }[];
    regime: {
      medianApr: number;
      latestApr: number;
      positiveShare: number;
      volatilityApr: number;
      percentile: number;
      label: "rich" | "normal" | "thin" | "inverted";
    } | null;
  };
};

const INTERVALS = ["1h", "4h", "1d", "1w"] as const;

export default function MarketsPage() {
  const [asset, setAsset] = useState<string>("BTC");
  const [interval, setInterval] = useState<string>("1d");

  const markets = useLive<MarketsResponse>("/api/markets", 15_000);
  const chart = useLive<CandlesResponse>(
    `/api/candles?asset=${asset}&interval=${interval}`,
    60_000,
  );

  // Memoised so the fallback [] is not a fresh array on every render, which
  // would invalidate every downstream useMemo.
  const quotes = useMemo(() => markets.data?.quotes ?? [], [markets.data]);
  const assetQuotes = useMemo(
    () => quotes.filter((q) => q.asset === asset),
    [quotes, asset],
  );

  return (
    <div className="space-y-3 p-3">
      <AssetStrip
        quotes={quotes}
        selected={asset}
        onSelect={setAsset}
        status={markets.status}
        ageSeconds={markets.ageSeconds}
      />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.6fr_1fr]">
        <Panel
          label={`${asset}/USDT`}
          hint="BINANCE SPOT · CANDLES WITH EMA + DONCHIAN"
          right={
            <div className="flex items-center gap-1">
              {INTERVALS.map((iv) => (
                <button
                  key={iv}
                  onClick={() => setInterval(iv)}
                  className={cx(
                    "micro border px-1.5 py-1 -ml-px first:ml-0 transition-colors",
                    interval === iv
                      ? "border-accent/50 bg-accent/10 text-accent z-10"
                      : "border-line-bright text-dim hover:text-muted",
                  )}
                >
                  {iv.toUpperCase()}
                </button>
              ))}
            </div>
          }
          flush
        >
          <div className="px-2 pb-2 pt-3">
            <CandleChart
              candles={chart.data?.candles ?? []}
              overlays={
                chart.data
                  ? [
                      {
                        label: "EMA 20",
                        values: chart.data.series.ema20,
                        color: "var(--color-s1)",
                      },
                      {
                        label: "EMA 50",
                        values: chart.data.series.ema50,
                        color: "var(--color-s4)",
                      },
                      {
                        label: "Donchian 20 high",
                        values: chart.data.series.donchianUpper,
                        color: "var(--color-accent)",
                      },
                      {
                        label: "Donchian 20 low",
                        values: chart.data.series.donchianLower,
                        color: "var(--color-accent)",
                      },
                    ]
                  : []
              }
              height={320}
            />
          </div>
        </Panel>

        <IndicatorPanel data={chart.data} asset={asset} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.6fr_1fr]">
        <Panel
          label="FUNDING HISTORY"
          hint={`${asset} PERP · BINANCE · ANNUALISED`}
          right={
            chart.data?.funding.regime && (
              <RegimeTag regime={chart.data.funding.regime.label} />
            )
          }
          flush
        >
          <div className="px-2 pb-2 pt-3">
            <FundingChart
              points={chart.data?.funding.history ?? []}
              height={110}
            />
          </div>
          <FundingRegimeFooter regime={chart.data?.funding.regime ?? null} />
        </Panel>

        <Panel label="VENUE COMPARISON" hint={`${asset} · ALL MARKETS`} flush>
          <VenueTable quotes={assetQuotes} />
        </Panel>
      </div>

      <Panel
        label="ALL MARKETS"
        hint="LIVE · BINANCE · BYBIT · HYPERLIQUID"
        right={<FeedState status={markets.status} age={markets.ageSeconds} />}
        flush
      >
        <FullTable quotes={quotes} onSelect={setAsset} selected={asset} />
      </Panel>

      {markets.data && markets.data.errors.length > 0 && (
        <Panel label="DEGRADED VENUES" hint="FEED ERRORS">
          <ul className="space-y-1.5">
            {markets.data.errors.map((e) => (
              <li key={e.venue} className="flex items-center gap-2 text-[12px]">
                <StatusDot state="bad" />
                <span className="text-ink">{e.venue}</span>
                <span className="text-muted">{e.message}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ asset strip */

function AssetStrip({
  quotes,
  selected,
  onSelect,
  status,
  ageSeconds,
}: {
  quotes: Quote[];
  selected: string;
  onSelect: (a: string) => void;
  status: string;
  ageSeconds: number;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {UNIVERSE.map((a) => {
        // Binance spot is the reference price: it is the deepest book and the
        // series the backtester replays, so the dashboard and research agree.
        const q =
          quotes.find((x) => x.asset === a && x.venue === "Binance" && x.kind === "spot") ??
          quotes.find((x) => x.asset === a && x.kind === "spot") ??
          quotes.find((x) => x.asset === a);
        const active = a === selected;
        return (
          <button
            key={a}
            onClick={() => onSelect(a)}
            className={cx(
              "min-w-[128px] shrink-0 border px-2.5 py-2 text-left transition-colors",
              active
                ? "border-accent/50 bg-accent/6"
                : "border-line bg-panel/70 hover:border-line-bright",
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={cx(
                  "text-[12px] tracking-wide",
                  active ? "text-accent" : "text-ink",
                )}
              >
                {a}
              </span>
              {q && <ChangeTag pct={q.change24hPct} />}
            </div>
            <div className="mt-1 text-[13px] text-ink">
              {q ? <Money usd={q.last} dp={q.last < 1 ? 5 : 2} /> : <span className="text-dim">—</span>}
            </div>
          </button>
        );
      })}
      <div className="ml-auto hidden shrink-0 items-center gap-2 pl-2 sm:flex">
        <FeedState status={status} age={ageSeconds} />
      </div>
    </div>
  );
}

function ChangeTag({ pct }: { pct: number }) {
  const t = pct > 0 ? "text-up" : pct < 0 ? "text-down" : "text-muted";
  const g = pct > 0 ? "▲" : pct < 0 ? "▼" : "—";
  return (
    <span className={cx("tnum text-[10px]", t)}>
      {g} {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

function FeedState({ status, age }: { status: string; age: number }) {
  const map: Record<string, "ok" | "warn" | "bad" | "idle"> = {
    live: "ok",
    stale: "warn",
    error: "bad",
    connecting: "idle",
  };
  return (
    <span className="micro flex items-center gap-1.5 text-dim">
      <StatusDot state={map[status] ?? "idle"} pulse={status === "live"} />
      {status.toUpperCase()}
      <span className="tnum">{age}s</span>
    </span>
  );
}

/* -------------------------------------------------------------- indicators */

function IndicatorPanel({
  data,
  asset,
}: {
  data: CandlesResponse | null;
  asset: string;
}) {
  const ind = data?.indicators;
  const price = ind?.price ?? 0;

  // Trend read is deliberately simple and stated as a *filter*, not a signal.
  // Price above both EMAs with the fast above the slow is the only condition
  // under which the trend strategy is permitted to look for a long entry.
  const trend =
    ind?.ema20 && ind?.ema50
      ? price > ind.ema20 && ind.ema20 > ind.ema50
        ? "up"
        : price < ind.ema20 && ind.ema20 < ind.ema50
          ? "down"
          : "mixed"
      : null;

  return (
    <Panel label="INDICATORS" hint={`${asset} · COMPUTED FROM THE SAME CODE THE ENGINE USES`}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Stat label="TREND FILTER">
          {trend === null ? (
            <span className="text-dim">—</span>
          ) : (
            <span
              className={cx(
                "text-[13px]",
                trend === "up" ? "text-up" : trend === "down" ? "text-down" : "text-warn",
              )}
            >
              {trend === "up" ? "▲ ALIGNED UP" : trend === "down" ? "▼ ALIGNED DOWN" : "— MIXED"}
            </span>
          )}
          <span className="sr-only">{trend ?? "unavailable"}</span>
        </Stat>

        <Stat
          label="RSI 14"
          sub={
            ind?.rsi14 != null && (
              <span className="text-dim">
                {ind.rsi14 > 70 ? "overbought zone" : ind.rsi14 < 30 ? "oversold zone" : "neutral"}
              </span>
            )
          }
        >
          <NumOrDash v={ind?.rsi14 ?? null} dp={1} />
        </Stat>

        <Stat label="EMA 20" sub={<span className="text-dim">fast</span>}>
          {ind?.ema20 != null ? <Money usd={ind.ema20} dp={ind.ema20 < 1 ? 5 : 2} /> : <Dash />}
        </Stat>

        <Stat label="EMA 50" sub={<span className="text-dim">slow</span>}>
          {ind?.ema50 != null ? <Money usd={ind.ema50} dp={ind.ema50 < 1 ? 5 : 2} /> : <Dash />}
        </Stat>

        <Stat
          label="ATR 14"
          sub={
            ind?.atrPct != null && (
              <span className="text-dim">{(ind.atrPct * 100).toFixed(2)}% of price</span>
            )
          }
        >
          {ind?.atr14 != null ? <Money usd={ind.atr14} dp={ind.atr14 < 1 ? 5 : 2} /> : <Dash />}
        </Stat>

        <Stat
          label="STOP DISTANCE"
          sub={<span className="text-dim">2.5 × ATR</span>}
        >
          {ind?.atrPct != null ? (
            <span className="tnum text-[15px]">{(ind.atrPct * 2.5 * 100).toFixed(2)}%</span>
          ) : (
            <Dash />
          )}
        </Stat>

        <Stat label="REALISED VOL 30D" sub={<span className="text-dim">annualised</span>}>
          {ind?.realisedVol30d != null ? (
            <span className="tnum text-[15px]">{(ind.realisedVol30d * 100).toFixed(1)}%</span>
          ) : (
            <Dash />
          )}
        </Stat>

        <Stat label="REALISED VOL 90D" sub={<span className="text-dim">annualised</span>}>
          {ind?.realisedVol90d != null ? (
            <span className="tnum text-[15px]">{(ind.realisedVol90d * 100).toFixed(1)}%</span>
          ) : (
            <Dash />
          )}
        </Stat>
      </div>

      <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
        Indicators are filters and sizing inputs, never standalone entries. RSI
        extremes in particular persist for days in a trending crypto market — it
        vetoes mean-reversion entries rather than generating them.
      </p>
    </Panel>
  );
}

function Dash() {
  return <span className="text-dim">—</span>;
}

function NumOrDash({ v, dp = 2 }: { v: number | null; dp?: number }) {
  if (v === null) return <Dash />;
  return <span className="tnum text-[15px]">{v.toFixed(dp)}</span>;
}

/* ------------------------------------------------------------------ regime */

function RegimeTag({ regime }: { regime: "rich" | "normal" | "thin" | "inverted" }) {
  const map = {
    rich: { tone: "up" as const, text: "RICH" },
    normal: { tone: "accent" as const, text: "NORMAL" },
    thin: { tone: "warn" as const, text: "THIN" },
    inverted: { tone: "down" as const, text: "INVERTED" },
  };
  const m = map[regime];
  return <Tag tone={m.tone}>FUNDING {m.text}</Tag>;
}

function FundingRegimeFooter({
  regime,
}: {
  regime: CandlesResponse["funding"]["regime"];
}) {
  if (!regime) {
    return (
      <div className="border-t border-line px-3 py-2.5 text-[11px] text-dim">
        No funding history available for this asset.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line px-3 py-3 sm:grid-cols-4">
      <Stat label="MEDIAN APR" sub={<span className="text-dim">robust to spikes</span>}>
        <span className={cx("tnum text-[15px]", regime.medianApr >= 0 ? "text-up" : "text-down")}>
          {(regime.medianApr * 100).toFixed(2)}%
        </span>
      </Stat>
      <Stat label="LATEST APR" sub={<span className="text-dim">single print</span>}>
        <span className={cx("tnum text-[15px]", regime.latestApr >= 0 ? "text-up" : "text-down")}>
          {(regime.latestApr * 100).toFixed(2)}%
        </span>
      </Stat>
      <Stat label="POSITIVE SHARE" sub={<span className="text-dim">persistence</span>}>
        <span className="tnum text-[15px]">{(regime.positiveShare * 100).toFixed(0)}%</span>
      </Stat>
      <Stat label="RATE VOLATILITY" sub={<span className="text-dim">regime stability</span>}>
        <span className="tnum text-[15px]">{(regime.volatilityApr * 100).toFixed(1)}%</span>
      </Stat>
    </div>
  );
}

/* ------------------------------------------------------------------ tables */

function VenueTable({ quotes }: { quotes: Quote[] }) {
  if (quotes.length === 0) {
    return <div className="p-3 text-[11px] text-dim">No venue data.</div>;
  }
  const sorted = [...quotes].sort(
    (a, b) => a.venue.localeCompare(b.venue) || a.kind.localeCompare(b.kind),
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line">
            <Th>VENUE</Th>
            <Th>MKT</Th>
            <Th right>PRICE</Th>
            <Th right>SPREAD</Th>
            <Th right>FUNDING APR</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((q) => (
            <tr key={`${q.venue}-${q.kind}`} className="border-b border-line/60">
              <Td>{q.venue}</Td>
              <Td>
                <span className="micro text-dim">{q.kind.toUpperCase()}</span>
              </Td>
              <Td right>
                <Money usd={q.last} dp={q.last < 1 ? 5 : 2} />
              </Td>
              <Td right>
                <span className="tnum text-muted">{q.spreadBps.toFixed(2)}bp</span>
              </Td>
              <Td right>
                {q.fundingApr === undefined ? (
                  <span className="text-dim">—</span>
                ) : (
                  <span
                    className={cx("tnum", q.fundingApr >= 0 ? "text-up" : "text-down")}
                    title={`${q.fundingRate! * 100}% per ${q.fundingIntervalHours}h`}
                  >
                    {(q.fundingApr * 100).toFixed(2)}%
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
        Funding is annualised from each venue&apos;s own interval — Binance and
        Bybit settle every 8h, Hyperliquid hourly. Comparing raw rates without
        normalising is a factor-of-eight error.
      </p>
    </div>
  );
}

function FullTable({
  quotes,
  onSelect,
  selected,
}: {
  quotes: Quote[];
  onSelect: (a: string) => void;
  selected: string;
}) {
  const { code } = useCurrency();
  const rows = useMemo(
    () =>
      [...quotes].sort(
        (a, b) =>
          a.asset.localeCompare(b.asset) ||
          a.venue.localeCompare(b.venue) ||
          a.kind.localeCompare(b.kind),
      ),
    [quotes],
  );

  if (rows.length === 0) {
    return <div className="p-3 text-[11px] text-dim">Loading live markets…</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line">
            <Th>ASSET</Th>
            <Th>VENUE</Th>
            <Th>MKT</Th>
            <Th right>LAST ({code})</Th>
            <Th right>24H</Th>
            <Th right>SPREAD</Th>
            <Th right>TOP OF BOOK</Th>
            <Th right>24H VOLUME</Th>
            <Th right>FUNDING APR</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <tr
              key={`${q.asset}-${q.venue}-${q.kind}`}
              onClick={() => onSelect(q.asset)}
              className={cx(
                "cursor-pointer border-b border-line/60 transition-colors hover:bg-raised/40",
                q.asset === selected && "bg-accent/4",
              )}
            >
              <Td>
                <span className={q.asset === selected ? "text-accent" : "text-ink"}>
                  {q.asset}
                </span>
              </Td>
              <Td>{q.venue}</Td>
              <Td>
                <span className="micro text-dim">{q.kind.toUpperCase()}</span>
              </Td>
              <Td right>
                <Money usd={q.last} dp={q.last < 1 ? 5 : 2} />
              </Td>
              <Td right>
                <ChangeTag pct={q.change24hPct} />
              </Td>
              <Td right>
                <span className="tnum text-muted">{q.spreadBps.toFixed(2)}bp</span>
              </Td>
              <Td right>
                {q.topOfBookUsd > 0 ? (
                  <Money usd={q.topOfBookUsd} compact dp={0} className="text-muted" />
                ) : (
                  <span className="text-dim" title="Venue does not publish top-of-book size here">
                    —
                  </span>
                )}
              </Td>
              <Td right>
                <Money usd={q.volume24hUsd} compact dp={0} className="text-muted" />
              </Td>
              <Td right>
                {q.fundingApr === undefined ? (
                  <span className="text-dim">—</span>
                ) : (
                  <span className={cx("tnum", q.fundingApr >= 0 ? "text-up" : "text-down")}>
                    {(q.fundingApr * 100).toFixed(2)}%
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
        Top of book is visible size at the touch only, not full book depth. Where
        it reads &ldquo;—&rdquo; the venue does not publish it, and the cost
        model charges a deliberately punitive slippage estimate rather than
        assuming the book is deep.
      </p>
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
