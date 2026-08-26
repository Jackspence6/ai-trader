"use client";

/**
 * The two desks, side by side, on the firm overview.
 *
 * This is the strip that makes Meridian one thing rather than two products
 * sharing a stylesheet. Each card answers the same four questions in the same
 * order — what is it worth, is it running, what is it holding, what is it
 * finding — so the desks can be read against each other rather than separately.
 *
 * A desk with no capital says so in the same place a desk with capital shows its
 * number. That symmetry is the point: "R0, nothing funded" is a legitimate state
 * for a desk to be in, and it should look like a state rather than a gap.
 */

import Link from "next/link";
import { useLive } from "@/lib/live";
import { Panel, Stat, StatusDot } from "@/components/ui";
import { DESKS } from "@/lib/nav";

type EventsSummary = {
  configured: boolean;
  migrated: boolean;
  engineAlive: boolean;
  booksReporting: number;
  booksIntegrated: number;
  openOpportunities: number;
  capitalZar: number;
  fundedStrategies: number;
};

export function DeskStrip({
  assetNavUsd,
  assetLiveStrategies,
  assetOpenPositions,
  assetScanning,
  halted,
}: {
  assetNavUsd: number | null;
  assetLiveStrategies: number;
  assetOpenPositions: number;
  assetScanning: number;
  halted: boolean;
}) {
  const events = useLive<EventsSummary>("/api/events/summary", 15_000);
  const e = events.data;
  const assets = DESKS.find((d) => d.key === "assets");
  const evDesk = DESKS.find((d) => d.key === "events");

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <DeskCard
        href="/markets"
        label={assets?.label ?? "ASSET MARKETS"}
        sub={assets?.sub ?? "Crypto · FX"}
        state={halted ? "bad" : assetScanning > 0 ? "ok" : "idle"}
        stateLabel={halted ? "HALTED" : assetScanning > 0 ? "SCANNING" : "IDLE"}
        stats={[
          {
            label: "Book value",
            value: assetNavUsd === null ? "—" : `$${assetNavUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
            sub: "paper — no live capital",
          },
          { label: "Funded strategies", value: String(assetLiveStrategies), sub: "at this tier" },
          { label: "Open positions", value: String(assetOpenPositions), sub: "paper book" },
          { label: "Scanning", value: String(assetScanning), sub: "crypto + forex" },
        ]}
      />

      <DeskCard
        href="/events"
        label={evDesk?.label ?? "EVENT MARKETS"}
        sub={evDesk?.sub ?? "Sports · Prediction"}
        state={
          !e || !e.configured ? "idle" : e.engineAlive ? "ok" : "warn"
        }
        stateLabel={
          !e
            ? "…"
            : !e.configured
              ? "NOT WIRED"
              : e.engineAlive
                ? "SCANNING"
                : "NO ENGINE"
        }
        stats={[
          { label: "Book value", value: "R0", sub: "no funded strategy yet" },
          {
            label: "Books reporting",
            value: e ? `${e.booksReporting} / ${e.booksIntegrated}` : "—",
            sub: "integrated feeds",
          },
          {
            label: "Open arbitrage",
            value: e ? String(e.openOpportunities) : "—",
            sub: "across all books",
          },
          { label: "Best measured gap", value: "−1.3%", sub: "two books, 2026-08-25" },
        ]}
      />
    </div>
  );
}

function DeskCard({
  href,
  label,
  sub,
  state,
  stateLabel,
  stats,
}: {
  href: string;
  label: string;
  sub: string;
  state: "ok" | "warn" | "bad" | "idle";
  stateLabel: string;
  stats: { label: string; value: string; sub: string }[];
}) {
  return (
    <Panel
      label={
        <Link href={href} className="transition-colors hover:text-ink">
          {label}
        </Link>
      }
      hint={sub}
      right={
        <span className="micro flex items-center gap-1.5 text-muted">
          <StatusDot state={state} pulse={state === "ok"} />
          {stateLabel}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <Stat key={s.label} label={s.label} sub={<span className="micro text-dim">{s.sub}</span>}>
            <span className="tnum text-ink">{s.value}</span>
          </Stat>
        ))}
      </div>
    </Panel>
  );
}
