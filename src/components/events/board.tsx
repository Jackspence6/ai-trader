"use client";

/**
 * The Event Markets board.
 *
 * One row per live arbitrage, sorted by the composite score, with the stake plan
 * a click away. Sorting and filtering are hand-rolled: the feed updates twice a
 * second and a table library's reconciliation is exactly the wrong thing in that
 * path.
 *
 * The empty state carries most of this screen's honesty. "No opportunities" and
 * "nothing is scanning" look identical if you only draw an empty table, and they
 * demand opposite responses from the operator — so they are drawn differently.
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Panel, cx } from "@/components/ui";
import { Empty, SkeletonTable, useNow } from "@/components/vis";
import { useOpportunityFeed } from "@/lib/events/useFeed";
import {
  ageSeconds,
  durationShort,
  marketLabel,
  pct,
  sastTime,
  zar,
} from "@/lib/events/format";
import type { Opportunity } from "@/lib/events/types";
import {
  FeedPill,
  RuleRiskBadge,
  ScoreBadge,
  TypeBadge,
  UrgencyBadge,
  VenueChip,
} from "./badges";
import { StakePlan } from "./stake-plan";

const TYPE_FILTERS = [
  { key: "all", label: "All" },
  { key: "bookie_vs_bookie", label: "Book vs book" },
  { key: "bookie_vs_polymarket", label: "Book vs prediction" },
  { key: "polymarket_internal", label: "Prediction internal" },
] as const;

type SortKey = "score" | "margin" | "profit" | "exec" | "window";

const SORTERS: Record<SortKey, (o: Opportunity) => number> = {
  score: (o) => o.score,
  margin: (o) => o.margin_pct,
  profit: (o) => o.guaranteed_profit_zar,
  exec: (o) => (Number.isFinite(o.executable_zar_per_leg) ? o.executable_zar_per_leg : 0),
  window: (o) => (o.state === "active" ? ageSeconds(o.first_seen) : (o.window_s ?? 0)),
};

const HEADERS: { key: SortKey | null; label: string; align?: "right" }[] = [
  { key: "score", label: "Score" },
  { key: null, label: "Event" },
  { key: null, label: "Market" },
  { key: null, label: "Route" },
  { key: "margin", label: "Margin", align: "right" },
  { key: "profit", label: "Locked", align: "right" },
  { key: "exec", label: "Exec / leg", align: "right" },
  { key: null, label: "Timing" },
  { key: null, label: "Books" },
  { key: null, label: "Rules" },
  { key: "window", label: "Open for" },
];

export function EventsBoard() {
  const { opps, status, flash } = useOpportunityFeed();
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDesc, setSortDesc] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [showExpired, setShowExpired] = useState(false);
  const params = useSearchParams();

  // The open plan is held as an *id*, not as a copy of the opportunity, and the
  // row is looked up from the live feed on every render. The previous version
  // stored the object and used two effects to keep it in step — one to adopt the
  // deep-linked row once it arrived, one to replace it whenever the feed moved.
  // Both were setState-inside-an-effect, which costs a second render pass on
  // every tick of a feed that ticks twice a second, and the second one raced the
  // first on load. Deriving it needs neither.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const deepLinked = params.get("opp");
  const selected =
    opps.find((o) => o.id === (selectedId ?? deepLinked)) ?? null;

  const rows = useMemo(() => {
    const filtered = opps.filter(
      (o) =>
        (showExpired || o.state === "active") &&
        (typeFilter === "all" || o.opp_type === typeFilter),
    );
    const f = SORTERS[sortKey];
    return [...filtered].sort((a, b) => (sortDesc ? f(b) - f(a) : f(a) - f(b)));
  }, [opps, typeFilter, showExpired, sortKey, sortDesc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  const active = opps.filter((o) => o.state === "active").length;
  // Ticks fast enough to expire a row flash cleanly; see useNow on why this is
  // not just Date.now() in the render body.
  const now = useNow(400);

  return (
    <div className="space-y-3">
      {status === "demo" && (
        <div className="border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] text-warn">
          <b>Simulated data.</b> These opportunities are invented so the interface can be
          shown without an engine behind it. Nothing here is placeable. Unset
          <code className="mx-1 text-warn/80">NEXT_PUBLIC_DEMO</code> to turn it off.
        </div>
      )}

      <Panel
        label="Live board"
        hint={`${active} open${opps.length !== active ? ` · ${opps.length - active} closed` : ""}`}
        right={<FeedPill status={status} />}
        flush
      >
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setTypeFilter(f.key)}
              className={cx(
                "micro border px-1.5 py-1 transition-colors",
                typeFilter === f.key
                  ? "border-accent/50 text-accent"
                  : "border-line-bright text-muted hover:text-ink",
              )}
            >
              {f.label}
            </button>
          ))}
          <span className="flex-1" />
          <button
            onClick={() => setShowExpired((s) => !s)}
            className={cx(
              "micro border px-1.5 py-1 transition-colors",
              showExpired
                ? "border-accent/50 text-accent"
                : "border-line-bright text-muted hover:text-ink",
            )}
          >
            {showExpired ? "Showing closed" : "Open only"}
          </button>
        </div>

        {rows.length === 0 ? (
          <EmptyBoard status={status} filtered={opps.length > 0} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  {HEADERS.map((h) => (
                    <th
                      key={h.label}
                      className={cx(
                        "px-3 py-2 font-normal",
                        h.align === "right" && "text-right",
                      )}
                    >
                      {h.key ? (
                        <button
                          onClick={() => toggleSort(h.key as SortKey)}
                          className={cx(
                            "micro transition-colors",
                            sortKey === h.key ? "text-accent" : "text-dim hover:text-muted",
                          )}
                        >
                          {h.label}
                          {sortKey === h.key ? (sortDesc ? " ↓" : " ↑") : ""}
                        </button>
                      ) : (
                        <span className="micro text-dim">{h.label}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const lit = (flash.get(o.id) ?? 0) > now - 1200;
                  const openFor =
                    o.state === "active" ? ageSeconds(o.first_seen) : (o.window_s ?? null);
                  return (
                    <tr
                      key={o.id}
                      onClick={() => setSelectedId(o.id)}
                      className={cx(
                        "cursor-pointer border-b border-line/60 transition-colors",
                        lit ? "bg-accent/[0.07]" : "hover:bg-raised/30",
                        o.state !== "active" && "opacity-50",
                      )}
                    >
                      <td className="px-3 py-2">
                        <ScoreBadge score={o.score} />
                      </td>
                      <td className="max-w-[220px] px-3 py-2">
                        <div className="truncate text-ink">{o.event_label}</div>
                        <div className="micro text-dim">
                          {o.league ?? o.sport} · {sastTime(o.start_time)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted">{marketLabel(o.market_key)}</td>
                      <td className="px-3 py-2">
                        <TypeBadge type={o.opp_type} />
                      </td>
                      <td className="tnum px-3 py-2 text-right text-up">
                        {pct(o.margin_pct)}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-ink">
                        {zar(o.guaranteed_profit_zar)}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-muted">
                        {zar(o.executable_zar_per_leg)}
                      </td>
                      <td className="px-3 py-2">
                        <UrgencyBadge urgency={o.urgency} />
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap gap-1">
                          {o.legs.map((l, i) => (
                            <VenueChip key={i} name={l.venue_name} isPm={l.is_pm} />
                          ))}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <RuleRiskBadge opp={o} />
                      </td>
                      <td className="tnum px-3 py-2 text-muted">
                        {durationShort(openFor)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Keyed on the opportunity so a different row gets a fresh panel rather
          than one that has to reset its own inputs in an effect. */}
      <StakePlan key={selected?.id} opp={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}

/**
 * An empty board has three different meanings and they are not interchangeable.
 * A market with no arbitrage in it is a finding; a scanner that is not running
 * is a fault; a filter hiding everything is neither. They share the firm's
 * empty-state component so that this desk's "nothing here" reads identically to
 * the other desk's.
 */
function EmptyBoard({ status, filtered }: { status: string; filtered: boolean }) {
  if (status === "down") {
    return (
      <Empty
        kind="fault"
        title="NOTHING IS SCANNING"
        body={
          <>
            No engine is connected and no database is configured, so this screen has no
            way to know what the books are doing. This is not an empty market — it is a
            blank instrument. Start the events engine, or point{" "}
            <code className="text-ink">DATABASE_URL</code> at the database it writes.
          </>
        }
      />
    );
  }
  if (status === "connecting") {
    return <SkeletonTable rows={5} cols={7} label="Looking for the engine" />;
  }
  if (filtered) {
    return (
      <Empty
        kind="idle"
        compact
        title="NOTHING MATCHES THIS FILTER"
        body="Widen the route filter, or switch to showing closed opportunities."
      />
    );
  }
  return (
    <Empty
      kind="idle"
      title="SCANNING · NO ARBITRAGE OPEN"
      body="The feed is live and the books are being read; none of them currently cross. That is the normal state of an efficient market and it is a measurement, not a fault — Research shows how close they have been getting."
    />
  );
}
