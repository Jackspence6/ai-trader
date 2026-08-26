"use client";

/**
 * The visual primitives every screen shares.
 *
 * Three ideas run through this file.
 *
 * **An empty panel is a message, not an absence.** Most of this interface spends
 * most of its time with nothing in it — no arbitrage open, no positions held, no
 * capital deployed. Those are the normal, correct states of a system that only
 * acts when the evidence says to, and they are also what someone looking at the
 * screen sees first. So they get a mark, a headline and a sentence, and the four
 * *reasons* a panel can be empty are drawn differently, because they demand
 * different responses: nothing to show, still loading, not built, or broken.
 *
 * **Loading is shaped like the thing that is coming.** A skeleton that matches
 * the eventual layout stops the page jumping when data lands, which is the
 * single biggest source of visual jank in a screen full of live tables.
 *
 * **Numbers move.** A figure that changes should be seen to change — but the
 * change is signalled with a background wash rather than by recolouring the
 * digits, because colour on a number already means up or down, and one channel
 * cannot carry two meanings.
 */

import { type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { cx, Micro } from "./ui";

/* ------------------------------------------------------------------ marks */

/**
 * The geometric mark on an empty panel. Drawn rather than imported: the whole
 * interface is built from hairlines and squares, and a rounded icon set would
 * read as borrowed.
 */
function EmptyMark({ kind }: { kind: EmptyKind }) {
  const tone =
    kind === "fault" ? "text-down" : kind === "absent" ? "text-warn" : "text-dim";
  return (
    <span className={cx("relative mb-3 block size-8", tone)} aria-hidden>
      <span className="absolute inset-0 border border-current opacity-40" />
      {kind === "waiting" && (
        <span
          className="absolute inset-[7px] border border-current"
          style={{ animation: "breathe 2s var(--ease-out) infinite" }}
        />
      )}
      {kind === "idle" && <span className="absolute inset-[7px] border border-current opacity-70" />}
      {kind === "absent" && (
        <span className="absolute left-1/2 top-1/2 h-[1px] w-4 -translate-x-1/2 -translate-y-1/2 bg-current" />
      )}
      {kind === "fault" && (
        <>
          <span className="absolute left-1/2 top-1/2 h-4 w-[1px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
          <span className="absolute left-1/2 top-1/2 h-4 w-[1px] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />
        </>
      )}
    </span>
  );
}

export type EmptyKind =
  /** Working correctly, nothing to show. The most common and least alarming. */
  | "idle"
  /** Data is on its way. */
  | "waiting"
  /** Deliberately not built yet. */
  | "absent"
  /** Something is wrong and someone should look. */
  | "fault";

/**
 * The empty state.
 *
 * `title` says what is true in three or four words; `body` says why, and what
 * it means. The distinction matters: "NO POSITIONS OPEN" and "NOTHING IS
 * SCANNING" both draw an empty table, and only one of them is a problem.
 */
export function Empty({
  kind = "idle",
  title,
  body,
  action,
  compact,
}: {
  kind?: EmptyKind;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  const titleTone =
    kind === "fault" ? "text-down" : kind === "absent" ? "text-warn" : "text-muted";
  return (
    <div
      className={cx(
        "rise flex flex-col items-center justify-center px-4 text-center",
        compact ? "py-6" : "py-12",
      )}
    >
      <EmptyMark kind={kind} />
      <Micro className={titleTone}>{title}</Micro>
      {body && (
        <p className="mt-2 max-w-md text-[11.5px] leading-relaxed text-dim">{body}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------- skeletons */

/** One shimmering bar. Width is a percentage so a column of them looks like
 *  text rather than like a progress bar. */
export function SkeletonBar({
  w = "100%",
  h = 10,
  className,
}: {
  w?: string | number;
  h?: number;
  className?: string;
}) {
  return (
    <span
      className={cx("skeleton block", className)}
      style={{ width: typeof w === "number" ? `${w}px` : w, height: h }}
      aria-hidden
    />
  );
}

/**
 * A table-shaped skeleton.
 *
 * Deliberately matches the real row height and column count so the layout does
 * not shift when the data arrives — the jump is what people notice, not the
 * wait.
 */
export function SkeletonTable({
  rows = 6,
  cols = 5,
  label = "Loading",
}: {
  rows?: number;
  cols?: number;
  label?: string;
}) {
  const widths = ["70%", "45%", "60%", "38%", "52%", "44%", "66%", "50%"];
  return (
    <div role="status" aria-label={label} className="px-3 py-2">
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-3 border-b border-line/50 py-2.5 last:border-0"
          style={{ opacity: 1 - r * (0.6 / rows) }}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonBar key={c} w={widths[(r + c) % widths.length]} h={9} className="flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** A chart-shaped skeleton: a plot area with a suggestion of a series in it. */
export function SkeletonChart({ height = 220 }: { height?: number }) {
  return (
    <div
      className="skeleton relative w-full"
      style={{ height }}
      role="status"
      aria-label="Loading chart"
    >
      <svg className="absolute inset-0 h-full w-full opacity-[0.18]" preserveAspectRatio="none" viewBox="0 0 100 40">
        <path
          d="M0 30 L12 26 L24 31 L36 20 L48 24 L60 12 L72 17 L84 8 L100 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.7"
          className="text-accent"
        />
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------ live values */

/**
 * A number that animates to its new value.
 *
 * Digits roll rather than swap, which makes a changing figure legible as a
 * change instead of a flicker. `flash` adds a one-shot background wash on
 * update for values where noticing the update matters more than reading the
 * transition — a price tick, a new margin.
 *
 * Reduced motion is handled by the global rule in globals.css: the roll
 * collapses to an instant set, and nothing else about the layout changes.
 */
export function LiveNumber({
  value,
  prefix,
  suffix,
  dp = 2,
  className,
  tone,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  dp?: number;
  className?: string;
  tone?: "up" | "down" | "muted" | "accent";
}) {
  const toneCls =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "accent"
          ? "text-accent"
          : tone === "muted"
            ? "text-muted"
            : "text-ink";
  return (
    <span className={cx("tnum tabular-nums", toneCls, className)}>
      {prefix}
      <NumberFlow
        value={value}
        format={{ minimumFractionDigits: dp, maximumFractionDigits: dp }}
        transformTiming={{ duration: 700, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}
        spinTiming={{ duration: 700, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}
        willChange
      />
      {suffix}
    </span>
  );
}

/* --------------------------------------------------------------- sparkline */

/**
 * A small series, drawn as a filled area with the last point marked.
 *
 * Hand-drawn SVG rather than a charting library: at this size a library spends
 * more code on axes and legends than on the line, and the line is the entire
 * point. The gradient fill is what makes a 40px-tall element read as data
 * rather than as decoration.
 */
export function Sparkline({
  points,
  height = 36,
  tone = "accent",
  className,
}: {
  points: number[];
  height?: number;
  tone?: "up" | "down" | "accent";
  className?: string;
}) {
  if (points.length < 2) {
    return <div style={{ height }} className={cx("w-full", className)} aria-hidden />;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  // Inset the drawing rather than letting it run to the box edge. A stroke on
  // the boundary of a viewBox is clipped in half, and the last-point marker
  // would sit outside it entirely — which is what makes an otherwise correct
  // sparkline look like it is leaking out of its panel.
  const PAD_X = 2.5;
  const PAD_TOP = 8;
  const PAD_BOT = 6;
  const x = (i: number) => PAD_X + (i / (points.length - 1)) * (100 - PAD_X * 2);
  const y = (v: number) =>
    100 - PAD_BOT - ((v - min) / span) * (100 - PAD_TOP - PAD_BOT);
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(" ");
  const area = `${d} L${x(points.length - 1).toFixed(2)} 100 L${PAD_X} 100 Z`;
  const uid = `spark-${tone}-${points.length}-${Math.abs(Math.round(points[0] * 1000))}`;
  const stroke =
    tone === "up" ? "var(--color-up)" : tone === "down" ? "var(--color-down)" : "var(--color-accent)";

  // The last point is drawn in HTML rather than SVG. `preserveAspectRatio="none"`
  // is what lets the series fill any panel width, but it scales x and y by
  // different factors, so a <circle> in that coordinate space renders as an
  // ellipse — subtly wrong, and consistently wrong in the same direction across
  // every sparkline on the screen.
  const markerLeft = `${x(points.length - 1)}%`;
  const markerTop = `${y(points[points.length - 1])}%`;

  return (
    <div className={cx("relative block w-full", className)} style={{ height }}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="block h-full w-full"
        aria-hidden
      >
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.30" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${uid})`} />
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <span
        className="pointer-events-none absolute size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full border"
        style={{ left: markerLeft, top: markerTop, borderColor: stroke, backgroundColor: "var(--color-bg)" }}
        aria-hidden
      />
    </div>
  );
}

/* ------------------------------------------------------------ live marker */

/**
 * The "this is updating" marker for a panel header.
 *
 * A slow breath rather than a blink: at a 2s cycle it reads as a heartbeat and
 * disappears into the periphery, where a 500ms blink would pull the eye away
 * from the data every half second.
 */
export function LivePulse({ label = "LIVE", stale }: { label?: string; stale?: boolean }) {
  return (
    <span className="micro inline-flex items-center gap-1.5 text-muted">
      <span
        className={cx("block size-1.5 rounded-full", stale ? "bg-warn" : "bg-up")}
        style={stale ? undefined : { animation: "breathe 2s var(--ease-out) infinite" }}
      />
      {stale ? "STALE" : label}
    </span>
  );
}
