"use client";

/**
 * Price and funding charts.
 *
 * Built as inline SVG rather than pulling in a charting library: these are
 * simple shapes, and the bundle cost of a general-purpose library is real while
 * the benefit here is not. `lightweight-charts` earns its place when we need
 * proper candle interaction (DESIGN.md §2); until then this is honest.
 *
 * Colour policy follows the design tokens: direction is never encoded by colour
 * alone — every series carries a direct label, and up/down also differ in
 * position and glyph.
 */

import { useMemo, useState } from "react";
import { cx } from "./ui";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

const W = 1000;

function scale(vals: number[], height: number, padT: number, padB: number) {
  const clean = vals.filter((v) => Number.isFinite(v));
  const lo = Math.min(...clean);
  const hi = Math.max(...clean);
  const span = hi - lo || Math.abs(hi) || 1;
  const pad = span * 0.1;
  const min = lo - pad;
  const max = hi + pad;
  return {
    min,
    max,
    y: (v: number) => padT + (1 - (v - min) / (max - min)) * (height - padT - padB),
  };
}

/**
 * Candlestick chart with optional overlay series.
 *
 * Wicks and bodies are drawn separately so a doji (open ≈ close) still renders
 * as a visible line rather than disappearing — a zero-height rect would vanish
 * exactly on the bars that often matter most.
 */
export function CandleChart({
  candles,
  overlays = [],
  height = 300,
}: {
  candles: Candle[];
  overlays?: { label: string; values: (number | null)[]; color: string }[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const padT = 12;
  const padB = 22;

  const geom = useMemo(() => {
    if (candles.length === 0) return null;
    const all = [
      ...candles.map((c) => c.h),
      ...candles.map((c) => c.l),
      ...overlays.flatMap((o) => o.values.filter((v): v is number => v !== null)),
    ];
    const s = scale(all, height, padT, padB);
    const step = W / candles.length;
    const bodyW = Math.max(step * 0.62, 1);
    return { s, step, bodyW };
  }, [candles, overlays, height]);

  if (!geom || candles.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[11px] text-dim"
        style={{ height }}
      >
        No price history available
      </div>
    );
  }

  const { s, step, bodyW } = geom;
  const active = hover === null ? null : candles[hover];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.min(candles.length - 1, Math.max(0, Math.floor(x / step))));
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={padT + f * (height - padT - padB)}
            y2={padT + f * (height - padT - padB)}
            stroke="var(--color-line)"
            strokeWidth={1}
          />
        ))}

        {candles.map((c, i) => {
          const x = i * step + step / 2;
          const up = c.c >= c.o;
          const col = up ? "var(--color-up)" : "var(--color-down)";
          const yO = s.y(c.o);
          const yC = s.y(c.c);
          const top = Math.min(yO, yC);
          const h = Math.max(Math.abs(yC - yO), 1);
          return (
            <g key={c.t}>
              <line
                x1={x}
                x2={x}
                y1={s.y(c.h)}
                y2={s.y(c.l)}
                stroke={col}
                strokeWidth={1}
                opacity={0.75}
              />
              <rect
                x={x - bodyW / 2}
                y={top}
                width={bodyW}
                height={h}
                fill={col}
                opacity={up ? 0.85 : 0.9}
              />
            </g>
          );
        })}

        {overlays.map((o) => {
          let d = "";
          let started = false;
          o.values.forEach((v, i) => {
            if (v === null) {
              started = false;
              return;
            }
            const x = i * step + step / 2;
            d += `${started ? "L" : "M"}${x.toFixed(1)},${s.y(v).toFixed(1)} `;
            started = true;
          });
          return (
            <path
              key={o.label}
              d={d}
              fill="none"
              stroke={o.color}
              strokeWidth={1.5}
              opacity={0.9}
            />
          );
        })}

        {hover !== null && (
          <line
            x1={hover * step + step / 2}
            x2={hover * step + step / 2}
            y1={padT}
            y2={height - padB}
            stroke="var(--color-line-bright)"
            strokeWidth={1}
          />
        )}
      </svg>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap gap-x-3 gap-y-1 px-1">
        {overlays.map((o) => (
          <span key={o.label} className="micro flex items-center gap-1.5">
            <span className="block h-[2px] w-3" style={{ background: o.color }} />
            <span className="text-dim">{o.label}</span>
          </span>
        ))}
      </div>

      {active && (
        <div className="pointer-events-none absolute right-1 top-0 flex gap-2.5 bg-panel/90 px-2 py-1">
          {(
            [
              ["O", active.o],
              ["H", active.h],
              ["L", active.l],
              ["C", active.c],
            ] as const
          ).map(([k, v]) => (
            <span key={k} className="micro">
              <span className="text-dim">{k}</span>{" "}
              <span className="tnum text-muted">
                {v.toLocaleString("en-US", { maximumFractionDigits: 4 })}
              </span>
            </span>
          ))}
          <span className="micro text-dim">
            {new Date(active.t).toISOString().slice(0, 10)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Funding-rate history as a zero-centred bar chart.
 *
 * Zero-centring is essential rather than cosmetic: the sign of funding decides
 * which side of the carry trade gets paid. A chart that hides the zero line
 * makes an inverted regime look like a merely-small positive one.
 */
export function FundingChart({
  points,
  height = 120,
}: {
  points: { t: number; apr: number }[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[11px] text-dim"
        style={{ height }}
      >
        No funding history available
      </div>
    );
  }

  const padT = 8;
  const padB = 8;
  const vals = points.map((p) => p.apr);
  const maxAbs = Math.max(...vals.map(Math.abs), 0.01);
  const zeroY = padT + (height - padT - padB) / 2;
  const half = (height - padT - padB) / 2;
  const step = W / points.length;
  const barW = Math.max(step * 0.7, 1);

  const active = hover === null ? null : points[hover];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.min(points.length - 1, Math.max(0, Math.floor(x / step))));
        }}
      >
        {points.map((p, i) => {
          const h = (Math.abs(p.apr) / maxAbs) * half;
          const x = i * step + step / 2 - barW / 2;
          const pos = p.apr >= 0;
          return (
            <rect
              key={p.t}
              x={x}
              y={pos ? zeroY - h : zeroY}
              width={barW}
              height={Math.max(h, 0.5)}
              fill={pos ? "var(--color-up)" : "var(--color-down)"}
              opacity={0.8}
            />
          );
        })}
        <line
          x1={0}
          x2={W}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--color-line-bright)"
          strokeWidth={1}
        />
      </svg>

      {active && (
        <div className="pointer-events-none absolute right-1 top-0 bg-panel/90 px-2 py-1">
          <span className="micro">
            <span className={cx("tnum", active.apr >= 0 ? "text-up" : "text-down")}>
              {(active.apr * 100).toFixed(2)}% APR
            </span>{" "}
            <span className="text-dim">
              {new Date(active.t).toISOString().slice(0, 16).replace("T", " ")}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
