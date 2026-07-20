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
 */

export type NavItem = {
  key: string;
  label: string;
  href: string;
  /** One-line purpose, shown in the command palette and as a title tooltip. */
  hint: string;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const NAV: NavGroup[] = [
  {
    label: "MONITOR",
    items: [
      {
        key: "command",
        label: "Command",
        href: "/",
        hint: "NAV, exposure, venue health, live strategy state",
      },
      {
        key: "markets",
        label: "Markets",
        href: "/markets",
        hint: "Live prices, funding, spreads and indicators across all venues",
      },
      {
        key: "signals",
        label: "Signals",
        href: "/signals",
        hint: "Every scored opportunity, taken or rejected, with the reason",
      },
      {
        key: "positions",
        label: "Positions",
        href: "/positions",
        hint: "Open positions, delta exposure, liquidation distance",
      },
    ],
  },
  {
    label: "OPERATE",
    items: [
      {
        key: "strategies",
        label: "Strategies",
        href: "/strategies",
        hint: "Which strategies run, in which mode, with what allocation",
      },
      {
        key: "allocation",
        label: "Allocation",
        href: "/allocation",
        hint: "Divide capital into sleeves — separate mandates, separate risk limits",
      },
      {
        key: "control",
        label: "Control",
        href: "/control",
        hint: "Thresholds, limits and risk parameters the engine trades under",
      },
      {
        key: "risk",
        label: "Risk",
        href: "/risk",
        hint: "Limit utilisation, breakers, kill-switch history",
      },
      {
        key: "treasury",
        label: "Treasury",
        href: "/treasury",
        hint: "Operator units, contributions, venue balances, the capital ladder",
      },
    ],
  },
  {
    label: "VERIFY",
    items: [
      {
        key: "research",
        label: "Research",
        href: "/research",
        hint: "Backtests, parameter sweeps, walk-forward analysis",
      },
      {
        key: "system",
        label: "System",
        href: "/system",
        hint: "Service health, feed lag, error rates, alert routing",
      },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);
