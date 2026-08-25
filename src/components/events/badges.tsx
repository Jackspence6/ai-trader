"use client";

/**
 * Event Markets chips.
 *
 * Built from the firm's own `Tag` and `StatusDot` rather than an icon set, so
 * this desk reads as the same instrument as the other one. Meridian draws its
 * marks geometrically; importing a rounded icon library for one desk would make
 * the two halves of the same screen look like two different products.
 */

import { Tag, StatusDot, cx } from "@/components/ui";
import { TYPE_LABEL, URGENCY_LABEL } from "@/lib/events/format";
import type { FeedStatus, Opportunity, VenueHealth } from "@/lib/events/types";

/** 0–100 composite. Tone is a coarse read; the drawer carries the breakdown. */
export function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 75 ? "up" : score >= 50 ? "accent" : "neutral";
  return (
    <Tag tone={tone} className="tnum font-medium">
      {score.toFixed(0)}
    </Tag>
  );
}

export function UrgencyBadge({ urgency }: { urgency: Opportunity["urgency"] }) {
  const tone = { low: "neutral", medium: "warn", high: "warn", critical: "down" } as const;
  return <Tag tone={tone[urgency] ?? "neutral"}>{URGENCY_LABEL[urgency] ?? urgency}</Tag>;
}

export function TypeBadge({ type }: { type: Opportunity["opp_type"] }) {
  const cls: Record<string, string> = {
    bookie_vs_bookie: "border-s1/40 text-s1",
    bookie_vs_polymarket: "border-s2/40 text-s2",
    polymarket_internal: "border-s3/40 text-s3",
    promo_boost: "border-warn/35 text-warn",
    promo_rollover: "border-warn/35 text-warn",
  };
  return (
    <span
      className={cx(
        "micro inline-flex items-center border px-1.5 py-1 whitespace-nowrap",
        cls[type] ?? "border-line-bright text-muted",
      )}
    >
      {TYPE_LABEL[type] ?? type}
    </span>
  );
}

export function VenueChip({ name, isPm }: { name: string; isPm: boolean }) {
  return <Tag tone={isPm ? "accent" : "neutral"}>{name}</Tag>;
}

/**
 * Whether the legs settle under compatible rules.
 *
 * "Clean" is the strong claim here, so it is the one that has to be earned: an
 * unverified rules profile is never clean, only unproven. A tennis leg on a book
 * whose retirement rule nobody has read is rule-risk, and says so.
 */
export function RuleRiskBadge({ opp }: { opp: Opportunity }) {
  if (!opp.rule_risk) return <Tag tone="up">clean</Tag>;
  return (
    <span
      className="micro inline-flex items-center border border-warn/35 px-1.5 py-1 whitespace-nowrap text-warn"
      title={opp.rule_risk_note ?? "Legs may settle under different rules"}
    >
      rule risk
    </span>
  );
}

const HEALTH: Record<VenueHealth["state"], { tone: "up" | "warn" | "down" | "neutral"; label: string }> = {
  ok: { tone: "up", label: "OK" },
  degraded: { tone: "warn", label: "Degraded" },
  stale: { tone: "warn", label: "Stale" },
  quarantined: { tone: "down", label: "Quarantined" },
  unconfigured: { tone: "neutral", label: "Not configured" },
};

export function HealthBadge({ state }: { state: VenueHealth["state"] }) {
  const m = HEALTH[state] ?? HEALTH.unconfigured;
  return <Tag tone={m.tone}>{m.label}</Tag>;
}

/**
 * Where the board's numbers are coming from.
 *
 * There are four honest answers and each one looks different, including the two
 * that mean "do not trade off this screen".
 */
export function FeedPill({ status }: { status: FeedStatus }) {
  const map: Record<FeedStatus, { state: "ok" | "warn" | "bad" | "idle"; label: string; title: string }> = {
    live: { state: "ok", label: "LIVE", title: "Reading the scanner's own output" },
    connecting: { state: "idle", label: "CONNECTING", title: "Looking for the engine" },
    demo: {
      state: "warn",
      label: "SIMULATED",
      title: "NEXT_PUBLIC_DEMO=1 — these opportunities are invented. Do not place them.",
    },
    down: {
      state: "bad",
      label: "NO FEED",
      title: "No engine and no database. Nothing is scanning — this is not an empty market.",
    },
  };
  const m = map[status];
  return (
    <span
      className="micro inline-flex items-center gap-1.5 border border-line-bright px-1.5 py-1 whitespace-nowrap text-muted"
      title={m.title}
    >
      <StatusDot state={m.state} />
      {m.label}
    </span>
  );
}
