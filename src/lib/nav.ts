/**
 * Navigation structure.
 *
 * Grouped by what the operator is trying to *do*, rather than as one flat list.
 * The three groups map to the loop this system runs on:
 *
 *   MONITOR — what is the market doing, and what did we see in it?
 *   OPERATE — what are we willing to do about it, and within what limits?
 *   VERIFY  — is any of this actually working?
 *
 * The split matters most between Strategies and Control. Strategies is about
 * *which* strategies run; Control is about the thresholds and limits they run
 * under. Mixing them in one screen makes it easy to change a global risk limit
 * while believing you changed one strategy's parameter.
 *
 * Each item carries everything every navigation surface needs — rail, mobile
 * sheet, command palette, breadcrumb — so a screen is added in exactly one
 * place and appears everywhere at once.
 */

export type NavBadge =
  /** Count of open paper/live positions. */
  | "positions"
  /** Red when the kill switch is engaged. */
  | "halted"
  /** Amber when any venue feed is erroring. */
  | "venues";

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
};

export type NavGroup = {
  key: string;
  label: string;
  /** Plain-language answer to "what do I come to this group for?" */
  sub: string;
  items: NavItem[];
};

export const NAV: NavGroup[] = [
  {
    key: "monitor",
    label: "MONITOR",
    sub: "What is happening",
    items: [
      {
        key: "command",
        label: "Overview",
        href: "/",
        hint: "The whole system at a glance — NAV, exposure, venue health",
        icon: "command",
        aliases: ["home", "dashboard", "command"],
      },
      {
        key: "markets",
        label: "Markets",
        href: "/markets",
        hint: "Live prices and funding rates on every exchange we watch",
        icon: "markets",
        aliases: ["prices", "funding", "quotes"],
      },
      {
        key: "performance",
        label: "Performance",
        href: "/performance",
        hint: "Profit and loss over time, and where it came from",
        icon: "performance",
        aliases: ["pnl", "returns", "attribution"],
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
    key: "operate",
    label: "OPERATE",
    sub: "What we allow",
    items: [
      {
        key: "strategies",
        label: "Strategies",
        href: "/strategies",
        hint: "The playbook — each strategy, its status and its track record",
        icon: "strategies",
        aliases: ["carry", "basis", "shadow"],
      },
      {
        key: "allocation",
        label: "Allocation",
        href: "/allocation",
        hint: "How capital is split between strategy groups (sleeves)",
        icon: "allocation",
        aliases: ["sleeves", "capital"],
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
        key: "treasury",
        label: "Treasury",
        href: "/treasury",
        hint: "The money itself — deposits, balances, and the capital ladder",
        icon: "treasury",
        aliases: ["ledger", "balances", "nav", "tier"],
      },
    ],
  },
  {
    key: "verify",
    label: "VERIFY",
    sub: "Is it working",
    items: [
      {
        key: "research",
        label: "Backtests",
        href: "/research",
        hint: "Would the strategy have made money on real history?",
        icon: "research",
        aliases: ["research", "backtest", "history"],
      },
      {
        key: "system",
        label: "System",
        href: "/system",
        hint: "Is the machinery running \u2014 trading loop, recorder, data feeds",
        icon: "system",
        badge: "venues",
        aliases: ["health", "logs", "recorder"],
      },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

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

/** The group a path belongs to — drives the top-bar breadcrumb. */
export function navLocation(
  path: string,
): { group: NavGroup; item: NavItem } | null {
  for (const group of NAV) {
    for (const item of group.items) {
      if (isNavActive(path, item.href)) return { group, item };
    }
  }
  return null;
}
