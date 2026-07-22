"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { NAV, isNavActive, navIndex, navLocation, type NavItem } from "@/lib/nav";
import { utcClock } from "@/lib/format";
import { useLive, type LiveState } from "@/lib/live";
import { CurrencySwitch, Money } from "@/lib/currency";
import { TIERS } from "@/lib/calc/tiers";
import type { EngineConfig } from "@/lib/engine/config";
import type { MarketSnapshot } from "@/lib/market/types";
import { CommandPalette } from "./command-palette";
import { NavIcon } from "./nav-icons";
import { cx, StatusDot } from "./ui";

/* ------------------------------------------------------------ Shell data */

/**
 * One polling loop for the whole chrome.
 *
 * The previous shell polled /api/halt from two components and /api/markets
 * and /api/config from a third — three timers asking the same questions. The
 * shell now fetches each endpoint once and every surface (kill switch, rail
 * badges, engine status, top bar) reads from here. One request cadence, one
 * consistent answer everywhere.
 */
type LadderResponse = {
  navUsd: number;
  currentTierId: string;
  impliedTierId: string;
  daysHeld: number;
  holdDaysRequired: number;
  awaitingPromotion: boolean;
  blockedBy: string | null;
};

type ShellData = {
  halt: LiveState<{ state: { halted: boolean } }>;
  config: LiveState<{ config: EngineConfig }>;
  markets: LiveState<MarketSnapshot>;
  positions: LiveState<{ open: number; isLive: boolean }>;
  ladder: LiveState<LadderResponse>;
};

const ShellCtx = createContext<ShellData | null>(null);

function useShellData(): ShellData {
  const d = useContext(ShellCtx);
  if (!d) throw new Error("useShellData outside Shell");
  return d;
}

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
  const { halt } = useShellData();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const halted = halt.data?.state.halted ?? null;

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
      halt.refresh();
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

/* ------------------------------------------------------------- Nav badges */

/**
 * The rail doubles as a status surface: an item with something live to say
 * says it in place, so a glance at the nav answers "is anything happening?"
 * without visiting every screen.
 */
function useBadge(item: NavItem): { text?: string; tone: "accent" | "down" | "warn" } | null {
  const { halt, markets, positions } = useShellData();
  switch (item.badge) {
    case "positions": {
      const n = positions.data?.open ?? 0;
      return n > 0 ? { text: String(n), tone: "accent" } : null;
    }
    case "halted":
      return halt.data?.state.halted ? { text: "HALT", tone: "down" } : null;
    case "venues": {
      const n = markets.data?.errors.length ?? 0;
      return n > 0 ? { text: String(n), tone: "warn" } : null;
    }
    default:
      return null;
  }
}

function Badge({ item, collapsed }: { item: NavItem; collapsed?: boolean }) {
  const b = useBadge(item);
  if (!b) return null;
  const tone =
    b.tone === "down" ? "bg-down" : b.tone === "warn" ? "bg-warn" : "bg-accent";
  if (collapsed) {
    // Icon-only rail: a corner dot carries the signal without the number.
    return <span className={cx("absolute right-2 top-1.5 size-1.5 rounded-full", tone)} />;
  }
  const text =
    b.tone === "down" ? "text-down border-down/40" : b.tone === "warn" ? "text-warn border-warn/40" : "text-accent border-accent/40";
  return (
    <span className={cx("micro ml-auto shrink-0 border px-1 py-0.5", text)}>{b.text}</span>
  );
}

/* -------------------------------------------------------------- Nav list */

function NavList({
  collapsed,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const path = usePathname();

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
      {NAV.map((group) => (
        <div key={group.key} className="py-1.5">
          {collapsed ? (
            <div className="mx-3 my-1 border-t border-line" aria-hidden />
          ) : (
            <div className="flex items-baseline gap-1.5 px-3 py-1">
              <span className="micro text-dim">{group.label}</span>
              <span className="text-[9.5px] lowercase tracking-wide text-dim/70">
                · {group.sub}
              </span>
            </div>
          )}
          <ul>
            {group.items.map((item) => {
              const active = isNavActive(path, item.href);
              return (
                <li key={item.key} className="relative">
                  <Link
                    href={item.href}
                    title={collapsed ? `${item.label} — ${item.hint}` : item.hint}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "group relative flex items-center gap-2.5 py-[7px] transition-colors",
                      collapsed ? "justify-center px-0" : "px-3",
                      active
                        ? "bg-raised/50 text-ink"
                        : "text-muted hover:bg-raised/25 hover:text-ink",
                    )}
                  >
                    {active && (
                      <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
                    )}
                    <NavIcon
                      id={item.icon}
                      className={cx(
                        "size-4 shrink-0 transition-colors",
                        active ? "text-accent" : "text-dim group-hover:text-muted",
                      )}
                    />
                    {!collapsed && (
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[12.5px] tracking-wide">
                            {item.label}
                          </span>
                          <span
                            className={cx(
                              "micro shrink-0",
                              active ? "text-accent" : "text-dim/70",
                            )}
                          >
                            {navIndex(item)}
                          </span>
                        </span>
                        {/* The active screen explains itself in place — one line
                            of purpose text under the label, only where you are.
                            This is what makes the rail self-teaching without
                            adding noise to the other twelve rows. */}
                        {active && (
                          <span className="mt-0.5 block text-[10px] leading-snug text-muted/80">
                            {item.hint}
                          </span>
                        )}
                      </span>
                    )}
                    <Badge item={item} collapsed={collapsed} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Rail */

function Mark() {
  return (
    <div className="relative size-4 shrink-0">
      <div className="absolute inset-0 border border-accent" />
      <div className="absolute inset-[3px] bg-accent" />
    </div>
  );
}

function Rail({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <nav
      className={cx(
        "hidden shrink-0 flex-col border-r border-line bg-panel/40 transition-[width] duration-200 md:flex",
        collapsed ? "w-[52px]" : "w-[188px]",
      )}
      aria-label="Primary"
    >
      <div
        className={cx(
          "flex h-12 items-center border-b border-line",
          collapsed ? "justify-center px-0" : "gap-2 px-3",
        )}
      >
        <Mark />
        {!collapsed && (
          <span className="text-[13px] font-medium tracking-[0.16em] text-ink">
            MERIDIAN
          </span>
        )}
      </div>

      <NavList collapsed={collapsed} />

      <EngineStatus collapsed={collapsed} />

      <button
        onClick={onToggle}
        title={collapsed ? "Expand navigation  ( [ )" : "Collapse navigation  ( [ )"}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        className={cx(
          "flex h-9 items-center border-t border-line text-dim transition-colors hover:text-ink",
          collapsed ? "justify-center" : "justify-between px-3",
        )}
      >
        {!collapsed && <span className="micro">COLLAPSE</span>}
        <span aria-hidden className="font-mono text-[11px]">
          {collapsed ? "»" : "«"}
        </span>
      </button>
    </nav>
  );
}

function EngineStatus({ collapsed }: { collapsed?: boolean }) {
  const { halt, config } = useShellData();
  const halted = halt.data?.state.halted ?? false;
  const nav = config.data?.config.navUsd ?? 0;

  // With no linked accounts there is no live capital, so every strategy is in
  // shadow. Saying "running · shadow" is the truthful description of that.
  const mode = halted ? "halted" : nav > 0 ? "running · live" : "running · shadow";

  if (collapsed) {
    return (
      <div className="flex justify-center border-t border-line py-3" title={`Engine: ${mode}`}>
        <StatusDot state={halted ? "bad" : "ok"} pulse={!halted} />
      </div>
    );
  }

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

/* ---------------------------------------------------------- Mobile sheet */

function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Escape closes; the sheet is the only focusable layer while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal aria-label="Navigation">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-[2px]" onClick={onClose} />
      <nav className="absolute inset-y-0 left-0 flex w-[228px] flex-col border-r border-line-bright bg-panel">
        <div className="flex h-12 items-center gap-2 border-b border-line px-3">
          <Mark />
          <span className="text-[13px] font-medium tracking-[0.16em] text-ink">
            MERIDIAN
          </span>
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="micro ml-auto border border-line px-1.5 py-1 text-dim hover:text-ink"
          >
            ESC
          </button>
        </div>
        <NavList onNavigate={onClose} />
        <EngineStatus />
      </nav>
    </div>
  );
}

/* ---------------------------------------------------------------- TopBar */

function TopBar({
  onOpenMobile,
  onOpenPalette,
}: {
  onOpenMobile: () => void;
  onOpenPalette: () => void;
}) {
  const { config, markets, ladder } = useShellData();
  const path = usePathname();
  const loc = navLocation(path);

  const nav = config.data?.config.navUsd ?? 0;

  // The effective tier comes from /api/ladder, which weighs NAV *history*
  // against the promotion hold. Resolving from NAV alone here always produced
  // T0 — the chip was decorative. Until the first response lands, T0 is the
  // honest placeholder because unproven capital trades at seed limits.
  const tierId = ladder.data?.currentTierId ?? "T0";
  const tier = TIERS.find((t) => t.id === tierId) ?? TIERS[0];
  const pending = ladder.data?.awaitingPromotion
    ? `Holding for ${ladder.data.blockedBy}: day ${ladder.data.daysHeld} of ${ladder.data.holdDaysRequired}`
    : null;

  const venuesUp = markets.data
    ? new Set(markets.data.quotes.map((q) => q.venue)).size
    : 0;
  const venuesDown = markets.data?.errors.length ?? 0;

  const feedState =
    markets.status === "live"
      ? "ok"
      : markets.status === "stale"
        ? "warn"
        : markets.status === "error"
          ? "bad"
          : "idle";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel/40 px-3 backdrop-blur">
      <button
        onClick={onOpenMobile}
        aria-label="Open navigation"
        className="flex size-7 flex-col items-center justify-center gap-[3px] border border-line text-muted hover:text-ink md:hidden"
      >
        <span className="block h-px w-3.5 bg-current" />
        <span className="block h-px w-3.5 bg-current" />
        <span className="block h-px w-3.5 bg-current" />
      </button>

      {/* Where am I — group / screen, straight from the nav model. */}
      {loc && (
        <div className="hidden items-baseline gap-1.5 lg:flex" aria-label="Breadcrumb">
          <span className="micro text-dim">{loc.group.label}</span>
          <span className="micro text-dim">∕</span>
          <span className="micro text-accent">{loc.item.label.toUpperCase()}</span>
        </div>
      )}

      <div className={cx("flex items-center gap-2", loc && "lg:border-l lg:border-line lg:pl-3")}>
        <span className="micro text-dim">TIER</span>
        <span
          className="micro border border-accent/40 px-1.5 py-1 text-accent"
          title={pending ?? tier.rationale ?? undefined}
        >
          {tier.id} · {tier.name.toUpperCase()}
        </span>
        {pending && ladder.data && (
          <span
            className="micro border border-warn/40 px-1.5 py-1 text-warn"
            title={pending}
          >
            ▸{ladder.data.blockedBy} {ladder.data.daysHeld}/{ladder.data.holdDaysRequired}D
          </span>
        )}
      </div>

      <div className="hidden items-baseline gap-2 border-l border-line pl-3 sm:flex">
        <span className="micro text-dim">NAV</span>
        <span className="text-[13px] text-ink">
          <Money usd={nav} />
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <button
          onClick={onOpenPalette}
          className="micro hidden h-7 items-center gap-2 border border-line px-2 text-dim transition-colors hover:border-line-bright hover:text-muted sm:flex"
          aria-label="Open command palette"
        >
          SEARCH
          <kbd className="font-mono text-[10px] tracking-normal">⌘K</kbd>
        </button>

        <CurrencySwitch />

        <div
          className="hidden items-center gap-1.5 border-l border-line pl-3 sm:flex"
          title={
            markets.data?.errors.length
              ? markets.data.errors.map((e) => `${e.venue}: ${e.message}`).join(" · ")
              : "All venue feeds healthy"
          }
        >
          <StatusDot state={venuesDown > 0 ? "warn" : feedState} pulse={feedState === "ok"} />
          <span className="micro text-muted">
            {venuesUp} VENUE{venuesUp === 1 ? "" : "S"}
            {venuesDown > 0 && <span className="text-warn"> · {venuesDown} DOWN</span>}
          </span>
          {markets.data && (
            <span className="micro text-dim" title="Age of the current market snapshot">
              {markets.ageSeconds}s
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

/* ------------------------------------------------------------ Page header */

/**
 * Every screen introduces itself.
 *
 * The rail names screens in one or two words; this strip is where the full
 * sentence lives. Whatever brought you here — a click, the palette, a shared
 * link — the first line on every page says what the screen is for, so no
 * screen requires already knowing what it is.
 */
function PageHeader() {
  const path = usePathname();
  const loc = navLocation(path);
  if (!loc) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line bg-panel/20 px-3 py-2">
      <h1 className="text-[13px] font-medium tracking-wide text-ink">
        {loc.item.label}
      </h1>
      <p className="text-[11px] text-muted">{loc.item.hint}</p>
    </div>
  );
}

/* ----------------------------------------------------------------- Shell */

const RAIL_KEY = "meridian.rail";

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const halt = useLive<{ state: { halted: boolean } }>("/api/halt", 10_000);
  const config = useLive<{ config: EngineConfig }>("/api/config", 30_000);
  const markets = useLive<MarketSnapshot>("/api/markets", 20_000);
  const positions = useLive<{ open: number; isLive: boolean }>("/api/positions", 30_000);
  const ladder = useLive<LadderResponse>("/api/ladder", 60_000);

  const data = useMemo<ShellData>(
    () => ({ halt, config, markets, positions, ladder }),
    [halt, config, markets, positions, ladder],
  );

  // Restore the operator's rail preference after mount — reading localStorage
  // during render would desync server and client HTML.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(window.localStorage.getItem(RAIL_KEY) === "collapsed");
  }, []);

  const toggleRail = useCallback(() => {
    setCollapsed((c) => {
      window.localStorage.setItem(RAIL_KEY, c ? "expanded" : "collapsed");
      return !c;
    });
  }, []);

  // Global keys: ⌘K / Ctrl+K for the palette anywhere; "[" collapses the rail
  // unless focus is in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === "[") {
        e.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRail]);

  // The lock screen is the front door, not a page inside the terminal — it
  // gets no nav rail, no top bar, and no kill switch.
  if (path === "/login") return <>{children}</>;

  return (
    <ShellCtx.Provider value={data}>
      <div className="relative z-10 flex h-dvh overflow-hidden">
        <Rail collapsed={collapsed} onToggle={toggleRail} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            onOpenMobile={() => setMobileOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          <PageHeader />
          <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
        </div>
      </div>
      <MobileNav open={mobileOpen} onClose={() => setMobileOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </ShellCtx.Provider>
  );
}
