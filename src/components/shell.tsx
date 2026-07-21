"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { NAV } from "@/lib/nav";
import { utcClock } from "@/lib/format";
import { useLive } from "@/lib/live";
import { CurrencySwitch, Money } from "@/lib/currency";
import { resolveTier } from "@/lib/calc/tiers";
import type { EngineConfig } from "@/lib/engine/config";
import type { MarketSnapshot } from "@/lib/market/types";
import { cx, StatusDot } from "./ui";

/* ------------------------------------------------------------- Kill switch */

/**
 * Two-stage halt control.
 *
 * Pinned to the header on every page (DESIGN.md §6). Requires a second click to
 * confirm and re-arms after four seconds, so a misclick cannot halt the system
 * — but a deliberate halt is never more than two clicks away from anywhere.
 *
 * Trips the real kill switch: halt state is set first, then resting orders are
 * cancelled at every venue we hold a credential for. Two other paths do the
 * same thing without a browser — `pnpm halt` and the standalone endpoint on
 * port 3999 — because this one stops working exactly when the dashboard does.
 */
function KillSwitch() {
  const [armed, setArmed] = useState(false);
  const [halted, setHalted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = (await fetch("/api/halt").then((r) => r.json())) as {
        state: { halted: boolean };
      };
      setHalted(d.state.halted);
    } catch {
      // Leave the last known state showing rather than claiming "running" on a
      // failed fetch — the wrong direction to guess.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  async function send(action: "halt" | "resume", reason: string) {
    setBusy(true);
    try {
      await fetch("/api/halt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      await load();
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  if (halted) {
    return (
      <Link
        href="/risk"
        className="micro flex h-7 items-center gap-2 border border-down bg-down px-2.5 text-bg"
        title="Trading is halted. Open the Risk screen to review and resume."
      >
        <span className="block size-1.5 bg-bg" />
        HALTED
      </Link>
    );
  }

  return (
    <button
      onClick={() =>
        armed ? send("halt", "Manual halt from the dashboard header") : setArmed(true)
      }
      disabled={busy}
      className={cx(
        "micro flex h-7 items-center gap-2 border px-2.5 transition-colors",
        armed
          ? "border-down bg-down text-bg"
          : "border-down/45 text-down hover:border-down hover:bg-down/10",
      )}
      aria-label={armed ? "Confirm halt all trading" : "Halt all trading"}
    >
      <span
        className={cx("block size-1.5", armed ? "bg-bg" : "bg-down")}
        style={armed ? undefined : { animation: "pulse-dot 2.4s ease-in-out infinite" }}
      />
      {busy ? "···" : armed ? "CONFIRM HALT" : "HALT"}
    </button>
  );
}

/* ----------------------------------------------------------------- Clock */

function Clock() {
  const [t, setT] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setT(utcClock(new Date()));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, []);
  // null on first paint avoids an SSR/client hydration mismatch
  return (
    <span className="tnum text-[11px] text-muted tabular-nums">
      {t ?? "--:--:--"}
      <span className="micro text-dim ml-1">UTC</span>
    </span>
  );
}

/* ------------------------------------------------------------------ Rail */

function Rail() {
  const path = usePathname();

  // Running index across groups, precomputed rather than mutated during render
  // so the numbering is a pure function of the nav structure.
  const startIndex: number[] = [];
  NAV.reduce((acc, g) => {
    startIndex.push(acc);
    return acc + g.items.length;
  }, 0);

  return (
    <nav className="hidden w-[176px] shrink-0 flex-col border-r border-line bg-panel/40 md:flex">
      <div className="flex h-12 items-center gap-2 border-b border-line px-3">
        <div className="relative size-4 shrink-0">
          <div className="absolute inset-0 border border-accent" />
          <div className="absolute inset-[3px] bg-accent" />
        </div>
        <span className="text-[13px] font-medium tracking-[0.16em] text-ink">
          MERIDIAN
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {NAV.map((group, gi) => (
          <div key={group.label} className="py-1.5">
            <div className="micro px-3 py-1 text-dim">{group.label}</div>
            <ul>
              {group.items.map((item, ii) => {
                const active = path === item.href;
                const n = startIndex[gi] + ii + 1;
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      title={item.hint}
                      className={cx(
                        "group relative flex items-center gap-2.5 px-3 py-[7px] transition-colors",
                        active ? "text-ink" : "text-muted hover:text-ink",
                      )}
                    >
                      {active && (
                        <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
                      )}
                      <span
                        className={cx(
                          "micro w-4 shrink-0",
                          active ? "text-accent" : "text-dim",
                        )}
                      >
                        {String(n).padStart(2, "0")}
                      </span>
                      <span className="text-[12.5px] tracking-wide">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <EngineStatus />
    </nav>
  );
}

function EngineStatus() {
  const cfg = useLive<{ config: EngineConfig }>("/api/config", 30_000);
  const haltState = useLive<{ state: { halted: boolean } }>("/api/halt", 15_000);
  const halted = haltState.data?.state.halted ?? false;
  const nav = cfg.data?.config.navUsd ?? 0;

  // With no linked accounts there is no live capital, so every strategy is in
  // shadow. Saying "running · shadow" is the truthful description of that.
  const mode = halted ? "halted" : nav > 0 ? "running · live" : "running · shadow";

  return (
    <div className="border-t border-line p-3">
      <div className="micro text-dim mb-1.5">ENGINE</div>
      <div className="flex items-center gap-2">
        <StatusDot state={halted ? "bad" : "ok"} pulse={!halted} />
        <span className="text-[11px] text-muted">{mode}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- TopBar */

function TopBar() {
  const cfg = useLive<{ config: EngineConfig }>("/api/config", 30_000);
  const mkt = useLive<MarketSnapshot>("/api/markets", 20_000);

  const nav = cfg.data?.config.navUsd ?? 0;
  const tier = resolveTier(nav, 0, "T0").current;

  const venuesUp = mkt.data
    ? new Set(mkt.data.quotes.map((q) => q.venue)).size
    : 0;
  const venuesDown = mkt.data?.errors.length ?? 0;

  const feedState =
    mkt.status === "live" ? "ok" : mkt.status === "stale" ? "warn" : mkt.status === "error" ? "bad" : "idle";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel/40 px-3 backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="micro text-dim">TIER</span>
        <span
          className="micro border border-accent/40 px-1.5 py-1 text-accent"
          title={tier.rationale || undefined}
        >
          {tier.id} · {tier.name.toUpperCase()}
        </span>
      </div>

      <div className="hidden items-baseline gap-2 border-l border-line pl-3 sm:flex">
        <span className="micro text-dim">NAV</span>
        <span className="text-[13px] text-ink">
          <Money usd={nav} />
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <CurrencySwitch />

        <div
          className="hidden items-center gap-1.5 border-l border-line pl-3 sm:flex"
          title={
            mkt.data?.errors.length
              ? mkt.data.errors.map((e) => `${e.venue}: ${e.message}`).join(" · ")
              : "All venue feeds healthy"
          }
        >
          <StatusDot state={venuesDown > 0 ? "warn" : feedState} pulse={feedState === "ok"} />
          <span className="micro text-muted">
            {venuesUp} VENUE{venuesUp === 1 ? "" : "S"}
            {venuesDown > 0 && <span className="text-warn"> · {venuesDown} DOWN</span>}
          </span>
          {mkt.data && (
            <span className="micro text-dim" title="Age of the current market snapshot">
              {mkt.ageSeconds}s
            </span>
          )}
        </div>

        <div className="hidden border-l border-line pl-3 sm:block">
          <Clock />
        </div>
        <KillSwitch />
      </div>
    </header>
  );
}

/* ----------------------------------------------------------------- Shell */

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();

  // The lock screen is the front door, not a page inside the terminal — it
  // gets no nav rail, no top bar, and no kill switch.
  if (path === "/login") return <>{children}</>;

  return (
    <div className="relative z-10 flex h-dvh overflow-hidden">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
