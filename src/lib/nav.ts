/**
 * Navigation structure.
 *
 * Meridian runs two desks against one book. The desks trade different things —
 * one prices assets, the other prices events — but they run the same loop, and
 * the rail is built to make that obvious rather than to hide it behind a
 * switcher:
 *
 *   FIRM           the consolidated view: what the whole book is worth, what it
 *                  earned, what it is allowed to lose, and whether the machinery
 *                  is running. Always visible, because the answer to "how are we
 *                  doing" is never one desk's answer.
 *   ASSET MARKETS  perpetual futures and FX. Carry, basis, peg.
 *   EVENT MARKETS  sportsbooks and prediction markets. Cross-venue arbitrage and
 *                  promotional hedging.
 *
 * Inside a desk the old three-phase grouping still holds, because it maps to the
 * loop an operator actually runs:
 *
 *   MONITOR — what is the market doing, and what did we see in it?
 *   OPERATE — what are we willing to do about it, and within what limits?
 *   VERIFY  — is any of this actually working?
 *
 * The split matters most between Strategies and Parameters. Strategies is about
 * *which* strategies run; Parameters is about the thresholds they run under.
 * Mixing them in one screen makes it easy to change a global risk limit while
 * believing you changed one strategy's dial.
 *
 * Both desks deliberately use the same words for the same ideas — Strategies,
 * Opportunities, Research, Parameters, and venues-you-hold-an-account-with
 * (Exchanges / Books). Learning one desk should teach you most of the other.
 *
 * Each item carries everything every navigation surface needs — rail, mobile
 * sheet, command palette, breadcrumb — so a screen is added in exactly one place
 * and appears everywhere at once.
 */

export type NavBadge =
  /** Count of open paper/live positions. */
  | "positions"
  /** Red when the kill switch is engaged. */
  | "halted"
  /** Amber when any venue feed is erroring. */
  | "venues"
  /** Count of live arbitrage opportunities on the event desk. */
  | "arbs"
  /** Amber while the event desk's books are unconfigured. */
  | "books";

export type NavItem = {
  key: string;
  label: string;
  href: string;
  /** One-line purpose — shown in the command palette and as a title tooltip. */
  hint: string;
  /** Glyph id, resolved by components/nav-icons.tsx. */
  icon: string;
  /** Live status this item surfaces in the rail, if any. */
  badge?: NavBadge;
  /** Extra terms the palette should match beyond the label. */
  aliases?: string[];
  /** Set when a screen is a placeholder for work that is not built yet. The rail
   *  dims it and the screen must say so plainly — a half-built screen that looks
   *  finished is worse than no screen. */
  unbuilt?: boolean;
};

export type NavGroup = {
  key: string;
  label: string;
  /** Plain-language answer to "what do I come to this group for?" */
  sub: string;
  items: NavItem[];
};

export type NavSection = {
  key: string;
  kind: "firm" | "desk";
  /** Rail heading. */
  label: string;
  /** What this desk trades, in two or three words. */
  sub: string;
  /** One sentence for the command palette and the desk header tooltip. */
  hint: string;
  /** Settlement currency this desk's book is kept in. */
  currency?: "USD" | "ZAR";
  groups: NavGroup[];
};

export const SECTIONS: NavSection[] = [
  /* ------------------------------------------------------------------ FIRM */
  {
    key: "firm",
    kind: "firm",
    label: "FIRM",
    sub: "Both desks",
    hint: "The consolidated book — value, performance, limits and machinery across every desk",
    groups: [
      {
        key: "firm-core",
        label: "FIRM",
        sub: "Both desks",
        items: [
          {
            key: "command",
            label: "Overview",
            href: "/",
            hint: "The whole firm at a glance — capital, exposure and desk health",
            icon: "command",
            aliases: ["home", "dashboard", "command", "firm"],
          },
          {
            key: "performance",
            label: "Performance",
            href: "/performance",
            hint: "Profit and loss over time, and which desk and strategy it came from",
            icon: "performance",
            aliases: ["pnl", "returns", "attribution"],
          },
          {
            key: "treasury",
            label: "Treasury",
            href: "/treasury",
            hint: "The money itself — deposits, balances, and the capital ladder",
            icon: "treasury",
            aliases: ["ledger", "balances", "nav", "tier", "capital"],
          },
          {
            key: "risk",
            label: "Risk",
            href: "/risk",
            hint: "Safety rails — loss limits, drawdown breakers, the kill switch",
            icon: "risk",
            badge: "halted",
            aliases: ["limits", "drawdown", "halt", "kill switch"],
          },
          {
            key: "system",
            label: "System",
            href: "/system",
            hint: "Is the machinery running — trading loop, scanners, data feeds",
            icon: "system",
            badge: "venues",
            aliases: ["health", "logs", "recorder", "uptime"],
          },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------- ASSET MARKETS */
  {
    key: "assets",
    kind: "desk",
    label: "ASSET MARKETS",
    sub: "Crypto · FX",
    hint: "Perpetual futures and currency pairs — funding carry, basis and peg",
    currency: "USD",
    groups: [
      {
        key: "assets-monitor",
        label: "MONITOR",
        sub: "What is happening",
        items: [
          {
            key: "markets",
            label: "Markets",
            href: "/markets",
            hint: "Live prices and funding rates on every exchange we watch",
            icon: "markets",
            aliases: ["prices", "funding", "quotes"],
          },
          {
            key: "signals",
            label: "Opportunities",
            href: "/signals",
            hint: "Every trade the engine considered — taken or rejected, with the reason",
            icon: "signals",
            aliases: ["signals", "scanner", "feed"],
          },
          {
            key: "positions",
            label: "Positions",
            href: "/positions",
            hint: "What we hold right now, and its live profit or loss",
            icon: "positions",
            badge: "positions",
            aliases: ["book", "exposure", "delta"],
          },
        ],
      },
      {
        key: "assets-operate",
        label: "OPERATE",
        sub: "What we allow",
        items: [
          {
            key: "strategies",
            label: "Strategies",
            href: "/strategies",
            hint: "The playbook — each strategy, its verdict and its track record",
            icon: "strategies",
            aliases: ["carry", "basis", "shadow"],
          },
          {
            key: "allocation",
            label: "Portfolios",
            href: "/allocation",
            hint: "Fund each portfolio, see what money is where and how it is doing",
            icon: "allocation",
            aliases: ["allocation", "sleeves", "capital", "fund"],
          },
          {
            key: "exchanges",
            label: "Exchanges",
            href: "/exchanges",
            hint: "Exchange accounts and API keys — withdrawal-blocked by design",
            icon: "exchanges",
            aliases: ["venues", "keys", "credentials", "binance", "bybit", "okx", "hyperliquid"],
          },
          {
            key: "control",
            label: "Parameters",
            href: "/control",
            hint: "The dials — thresholds, sizing and limits the engine trades under",
            icon: "control",
            aliases: ["control", "settings", "config", "thresholds"],
          },
        ],
      },
      {
        key: "assets-verify",
        label: "VERIFY",
        sub: "Is it working",
        items: [
          {
            key: "research",
            label: "Research",
            href: "/research",
            hint: "Would the strategy have made money on real history?",
            icon: "research",
            aliases: ["backtest", "history", "sweeps", "verdicts"],
          },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------- EVENT MARKETS */
  {
    key: "events",
    kind: "desk",
    label: "EVENT MARKETS",
    sub: "Sports · Prediction",
    hint: "Sportsbooks and prediction markets — cross-venue arbitrage and promotional hedging",
    currency: "ZAR",
    groups: [
      {
        key: "events-monitor",
        label: "MONITOR",
        sub: "What is happening",
        items: [
          {
            key: "events-board",
            label: "Board",
            href: "/events",
            hint: "Live arbitrage across the books and prediction markets we quote",
            icon: "signals",
            badge: "arbs",
            aliases: ["arb", "arbitrage", "opportunities", "odds", "board"],
          },
          {
            key: "events-books",
            label: "Books",
            href: "/events/books",
            hint: "Bookmakers and prediction markets — feed health and settlement rules",
            icon: "exchanges",
            badge: "books",
            aliases: ["venues", "bookmakers", "sunbet", "betway", "polymarket", "feeds"],
          },
        ],
      },
      {
        key: "events-operate",
        label: "OPERATE",
        sub: "What we allow",
        items: [
          {
            key: "events-strategies",
            label: "Strategies",
            href: "/events/strategies",
            hint: "Each edge on this desk, its verdict, and what it is allowed to do",
            icon: "strategies",
            aliases: ["edges", "cross-book", "verdicts"],
          },
          {
            key: "events-promotions",
            label: "Promotions",
            href: "/events/promotions",
            hint: "Bonus rollover hedging — the value, and what it takes to start",
            icon: "treasury",
            aliases: ["promos", "bonus", "rollover", "matched betting", "capital"],
          },
          {
            key: "events-parameters",
            label: "Parameters",
            href: "/events/parameters",
            hint: "Scan thresholds, staking limits and execution assumptions",
            icon: "control",
            aliases: ["settings", "config", "margin", "slippage", "thresholds"],
          },
        ],
      },
      {
        key: "events-verify",
        label: "VERIFY",
        sub: "Is it working",
        items: [
          {
            key: "events-research",
            label: "Research",
            href: "/events/research",
            hint: "What has been measured on this desk, and what it found",
            icon: "research",
            aliases: ["evidence", "analytics", "capture", "go/no-go"],
          },
        ],
      },
    ],
  },
];

/** Flat item list in rail order — palette, numbering and prev/next all use it. */
export const ALL_NAV_ITEMS: NavItem[] = SECTIONS.flatMap((s) =>
  s.groups.flatMap((g) => g.items),
);

/** Legacy flat shape. Kept so any surface still thinking in groups keeps working. */
export const NAV: NavGroup[] = SECTIONS.flatMap((s) => s.groups);

/** Group + ordinal for an item ("02" etc), used by rail numbering and palette. */
export function navIndex(item: NavItem): string {
  const i = ALL_NAV_ITEMS.findIndex((x) => x.key === item.key);
  return String(i + 1).padStart(2, "0");
}

/**
 * Active-state matching. "/" only matches exactly (it is a prefix of every
 * route); everything else also claims its subroutes, so a future
 * /positions/BTC detail page still lights the Positions entry.
 */
export function isNavActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

/**
 * The section, group and item a path belongs to — drives the breadcrumb and
 * decides which desk the rail opens on. Longest href wins, so /events/books
 * resolves to Books rather than to the Board it sits under.
 */
export function navLocation(
  path: string,
): { section: NavSection; group: NavGroup; item: NavItem } | null {
  let best: { section: NavSection; group: NavGroup; item: NavItem } | null = null;
  for (const section of SECTIONS) {
    for (const group of section.groups) {
      for (const item of group.items) {
        if (!isNavActive(path, item.href)) continue;
        if (!best || item.href.length > best.item.href.length) {
          best = { section, group, item };
        }
      }
    }
  }
  return best;
}

/** The desk a path belongs to, or null on a firm-level screen. */
export function activeDesk(path: string): NavSection | null {
  const loc = navLocation(path);
  return loc && loc.section.kind === "desk" ? loc.section : null;
}

export const DESKS: NavSection[] = SECTIONS.filter((s) => s.kind === "desk");
