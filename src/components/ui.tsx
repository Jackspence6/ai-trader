import type { ReactNode } from "react";
import { splitNum } from "@/lib/format";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------------------------------------------- Panel */

export function Panel({
  label,
  hint,
  right,
  children,
  className,
  flush,
}: {
  label?: ReactNode;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section
      className={cx(
        "ticked relative border border-line bg-panel/70 backdrop-blur-[1px]",
        className,
      )}
    >
      {label && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="micro text-muted whitespace-nowrap">{label}</h2>
            {hint && <span className="micro text-dim truncate">{hint}</span>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className={flush ? "" : "p-3"}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------- Numerics */

/** Renders a number with a dimmed fractional part — improves column scanning. */
export function Num({
  value,
  dp = 2,
  prefix,
  suffix,
  className,
  sign,
}: {
  value: number;
  dp?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  sign?: boolean;
}) {
  const [int, frac] = splitNum(value, dp);
  const s = sign ? (value >= 0 ? "+" : "−") : value < 0 ? "−" : "";
  return (
    <span className={cx("tnum", className)}>
      {s}
      {prefix}
      {int}
      {frac && <span className="opacity-45">.{frac}</span>}
      {suffix}
    </span>
  );
}

/** Signed value with an arrow glyph so direction is never color-alone. */
export function Delta({
  value,
  dp = 2,
  suffix,
  prefix,
  className,
}: {
  value: number;
  dp?: number;
  suffix?: string;
  prefix?: string;
  className?: string;
}) {
  const t = value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted";
  const glyph = value > 0 ? "▲" : value < 0 ? "▼" : "—";
  return (
    <span className={cx("tnum inline-flex items-baseline gap-1", t, className)}>
      <span className="text-[0.7em] leading-none">{glyph}</span>
      <Num value={Math.abs(value)} dp={dp} prefix={prefix} suffix={suffix} />
    </span>
  );
}

/* --------------------------------------------------------------- Labels */

export function Micro({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("micro text-dim", className)}>{children}</div>;
}

export function StatusDot({
  state,
  pulse,
}: {
  state: "ok" | "warn" | "bad" | "idle";
  pulse?: boolean;
}) {
  const c =
    state === "ok"
      ? "bg-up"
      : state === "warn"
        ? "bg-warn"
        : state === "bad"
          ? "bg-down"
          : "bg-dim";
  return (
    <span
      className={cx("inline-block size-1.5 rounded-full shrink-0", c)}
      style={pulse ? { animation: "pulse-dot 2.4s ease-in-out infinite" } : undefined}
    />
  );
}

export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "up" | "down" | "warn" | "accent";
  className?: string;
}) {
  const map = {
    neutral: "border-line-bright text-muted",
    up: "border-up/35 text-up",
    down: "border-down/35 text-down",
    warn: "border-warn/35 text-warn",
    accent: "border-accent/35 text-accent",
  } as const;
  return (
    <span
      className={cx(
        "micro inline-flex items-center border px-1.5 py-1 whitespace-nowrap",
        map[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- Meter */

export function Meter({
  used,
  limit,
  label,
  unit = "",
}: {
  used: number;
  limit: number;
  label: string;
  unit?: string;
}) {
  const p = limit === 0 ? 0 : Math.min(100, (used / limit) * 100);
  const state = p >= 85 ? "bad" : p >= 60 ? "warn" : "ok";
  const bar =
    state === "bad" ? "bg-down" : state === "warn" ? "bg-warn" : "bg-accent";
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="micro text-muted truncate">{label}</span>
        <span className="tnum text-[11px] text-muted shrink-0">
          {unit === "$" ? unit : ""}
          {used.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          <span className="text-dim">
            {" / "}
            {unit === "$" ? unit : ""}
            {limit.toLocaleString("en-US")}
            {unit !== "$" ? unit : ""}
          </span>
        </span>
      </div>
      <div className="h-[3px] w-full bg-raised overflow-hidden">
        <div className={cx("h-full transition-all", bar)} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Stat tile */

export function Stat({
  label,
  children,
  sub,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("min-w-0", className)}>
      <Micro className="mb-1.5">{label}</Micro>
      <div className="text-[15px] leading-none text-ink">{children}</div>
      {sub && <div className="mt-1.5 text-[11px] leading-none">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- Info tips */

import { GLOSSARY } from "@/lib/glossary";

/**
 * The ⓘ next to jargon — a plain-English explanation on hover or tap.
 *
 * The operators are not finance professionals, and no screen should require
 * them to be. Terms come from the shared glossary so every surface explains
 * a word the same way. Rendered as a button for keyboard and touch access;
 * the tip itself is pure CSS (group-hover / focus-within), no state.
 */
export function Info({ term, className }: { term: string; className?: string }) {
  const text = GLOSSARY[term];
  if (!text) return null;
  return (
    <span className={cx("group relative inline-flex", className)}>
      <button
        type="button"
        aria-label={`What does this mean? ${text}`}
        className="flex size-3.5 items-center justify-center rounded-full border border-line-bright text-[8px] leading-none text-dim transition-colors hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-1.5 w-60 -translate-x-1/2 border border-line-bright bg-raised p-2 text-left text-[11px] font-normal normal-case leading-relaxed tracking-normal text-ink opacity-0 shadow-[0_8px_30px_rgba(0,0,0,0.5)] transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
