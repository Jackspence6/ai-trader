"use client";

import { useMemo, useRef, useState } from "react";
import { cx, Num } from "./ui";

/* ------------------------------------------------------- NAV area chart */

type Pt = { t: string; v: number };

/**
 * Single-series area chart with crosshair + tooltip.
 * One series, so no legend box — the panel title names it.
 */
export function NavChart({ data, height = 172 }: { data: Pt[]; height?: number }) {
  const [idx, setIdx] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  const W = 1000;
  const H = height;
  const padT = 10;
  const padB = 16;

  const { path, area, xs, ys } = useMemo(() => {
    const vs = data.map((d) => d.v);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const span = hi - lo || 1;
    const pad = span * 0.12;
    const min = lo - pad;
    const max = hi + pad;
    const xs = data.map((_, i) => (i / (data.length - 1)) * W);
    const ys = data.map(
      (d) => padT + (1 - (d.v - min) / (max - min)) * (H - padT - padB),
    );
    const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${ys[i].toFixed(2)}`).join(" ");
    const area = `${path} L${W},${H - padB} L0,${H - padB} Z`;
    return { path, area, xs, ys };
  }, [data, H]);

  const first = data[0]?.v ?? 0;
  const last = data[data.length - 1]?.v ?? 0;
  const rising = last >= first;
  const stroke = rising ? "var(--color-up)" : "var(--color-down)";

  function onMove(e: React.PointerEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    const i = Math.round(rel * (data.length - 1));
    setIdx(Math.max(0, Math.min(data.length - 1, i)));
  }

  const active = idx !== null ? data[idx] : null;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full touch-none"
        style={{ height }}
        onPointerMove={onMove}
        onPointerLeave={() => setIdx(null)}
        role="img"
        aria-label={`Net asset value over ${data.length} days`}
      >
        <defs>
          <linearGradient id="navfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.16" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* recessive gridlines */}
        {[0, 0.5, 1].map((f) => {
          const y = padT + f * (H - padT - padB);
          return (
            <line
              key={f}
              x1="0"
              x2={W}
              y1={y}
              y2={y}
              stroke="var(--color-line)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        <path d={area} fill="url(#navfill)" />
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {idx !== null && (
          <>
            <line
              x1={xs[idx]}
              x2={xs[idx]}
              y1={padT}
              y2={H - padB}
              stroke="var(--color-line-bright)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {/* 2px surface ring so the marker reads over the line */}
            <circle
              cx={xs[idx]}
              cy={ys[idx]}
              r="4"
              fill={stroke}
              stroke="var(--color-panel)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      {/* date axis */}
      <div className="pointer-events-none flex items-center justify-between border-t border-line px-3 py-1.5">
        {[0, Math.floor(data.length / 2), data.length - 1].map((i) => (
          <span key={i} className="micro text-dim">
            {new Date(data[i].t).toISOString().slice(0, 10)}
          </span>
        ))}
      </div>

      {active && (
        <div
          className="pointer-events-none absolute top-1 z-10 border border-line-bright bg-raised px-2 py-1.5 shadow-lg"
          style={{
            left: `${(xs[idx!] / W) * 100}%`,
            transform:
              xs[idx!] / W > 0.7 ? "translateX(-108%)" : "translateX(8%)",
          }}
        >
          <div className="micro text-dim mb-1">
            {new Date(active.t).toISOString().slice(0, 10)}
          </div>
          <div className="tnum text-[13px] text-ink">
            <Num value={active.v} prefix="$" />
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- Sparkline */

export function Spark({
  data,
  className,
  width = 96,
  height = 22,
}: {
  data: number[];
  className?: string;
  width?: number;
  height?: number;
}) {
  const lo = Math.min(...data);
  const hi = Math.max(...data);
  const span = hi - lo || 1;
  const d = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - 2 - ((v - lo) / span) * (height - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = data[data.length - 1] >= data[0];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cx("overflow-visible", className)}
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        stroke={rising ? "var(--color-up)" : "var(--color-down)"}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------- Allocation split bar */

/**
 * Horizontal composition bar. Categorical colors carry a CVD warning,
 * so every segment is direct-labeled below — never color alone.
 */
export function SplitBar({
  segments,
}: {
  segments: { label: string; value: number; colorVar: string; sub?: string }[];
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className="space-y-2.5">
      <div className="flex h-2 w-full gap-[2px] overflow-hidden">
        {segments.map((s) => (
          <div
            key={s.label}
            style={{
              width: `${(s.value / total) * 100}%`,
              backgroundColor: `var(${s.colorVar})`,
            }}
          />
        ))}
      </div>
      <ul className="space-y-1.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[11px]">
            <span
              className="size-2 shrink-0"
              style={{ backgroundColor: `var(${s.colorVar})` }}
            />
            <span className="text-muted truncate">{s.label}</span>
            <span className="ml-auto tnum text-ink shrink-0">
              <Num value={s.value} prefix="$" />
            </span>
            <span className="tnum text-dim w-11 text-right shrink-0">
              {((s.value / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
