/**
 * Fund accounting — operators, units, and NAV.
 *
 * DESIGN.md §7 makes the case for unit accounting and it is worth restating,
 * because it is the one piece here that is impossible to retrofit accurately:
 *
 * With several operators contributing different amounts at different times, raw
 * percentage returns become wrong very fast. If one operator adds capital right
 * before a good week, naive splitting credits everyone equally and the division
 * is simply incorrect. So the fund is accounted like a real fund: each
 * contribution buys units at the prevailing NAV-per-unit, each withdrawal
 * redeems them, and an operator's stake is always `units × NAV per unit`.
 *
 * That gives correct ownership regardless of timing, plus time-weighted return
 * (strategy performance) and money-weighted return (each operator's actual
 * experience) as separate, both-correct numbers.
 *
 * Right now there are no contributions and no capital. Everything below
 * correctly reports zero rather than a placeholder — the machinery is in place
 * for when the first real deposit lands.
 */

export type Operator = {
  id: string;
  name: string;
  initials: string;
  /** Series colour token for charts. Direct labels are still required. */
  colorVar: string;
};

/** The three operators of the fund. */
export const OPERATORS: Operator[] = [
  { id: "js", name: "Jack Spence", initials: "JS", colorVar: "--color-s1" },
  { id: "fm", name: "Finn Mclaughlin", initials: "FM", colorVar: "--color-s3" },
  { id: "lk", name: "Lourens Kok", initials: "LK", colorVar: "--color-s4" },
];

export type CapitalEvent = {
  id: string;
  operatorId: string;
  type: "contribution" | "withdrawal";
  /** USD amount. */
  amountUsd: number;
  /** NAV per unit at the time of the event. */
  navPerUnit: number;
  ts: number;
};

/**
 * The capital event log.
 *
 * Empty. No operator has contributed capital and no exchange account is linked,
 * so the honest state of this fund is zero — not a seeded example.
 */
export const CAPITAL_EVENTS: CapitalEvent[] = [];

export const INITIAL_NAV_PER_UNIT = 1;

export type OperatorPosition = {
  operator: Operator;
  units: number;
  contributedUsd: number;
  withdrawnUsd: number;
  /** Current value of the holding: units × NAV per unit. */
  valueUsd: number;
  /** Profit against net capital contributed. */
  pnlUsd: number;
  /** Share of the fund, 0–1. */
  share: number;
};

export type FundState = {
  navUsd: number;
  navPerUnit: number;
  unitsOutstanding: number;
  totalContributedUsd: number;
  totalWithdrawnUsd: number;
  /** NAV minus net capital in — the fund's actual trading profit. */
  pnlUsd: number;
  pnlPct: number;
  positions: OperatorPosition[];
  funded: boolean;
};

/**
 * Derive full fund state from the event log and current NAV.
 *
 * Units are computed by replaying events in order, because the number of units
 * a contribution buys depends on NAV per unit *at that moment*. Replaying is
 * cheap at our volume and keeps a single source of truth — a cached unit count
 * that drifts from the event log is a dispute waiting to happen.
 */
export function computeFundState(
  navUsd: number,
  events: CapitalEvent[] = CAPITAL_EVENTS,
  operators: Operator[] = OPERATORS,
): FundState {
  const units = new Map<string, number>();
  const contributed = new Map<string, number>();
  const withdrawn = new Map<string, number>();

  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  let unitsOutstanding = 0;

  for (const e of ordered) {
    const price = e.navPerUnit > 0 ? e.navPerUnit : INITIAL_NAV_PER_UNIT;
    const delta = e.amountUsd / price;

    if (e.type === "contribution") {
      units.set(e.operatorId, (units.get(e.operatorId) ?? 0) + delta);
      contributed.set(e.operatorId, (contributed.get(e.operatorId) ?? 0) + e.amountUsd);
      unitsOutstanding += delta;
    } else {
      units.set(e.operatorId, (units.get(e.operatorId) ?? 0) - delta);
      withdrawn.set(e.operatorId, (withdrawn.get(e.operatorId) ?? 0) + e.amountUsd);
      unitsOutstanding -= delta;
    }
  }

  // With no units issued there is no meaningful price per unit. Report the
  // initial value rather than dividing by zero.
  const navPerUnit = unitsOutstanding > 0 ? navUsd / unitsOutstanding : INITIAL_NAV_PER_UNIT;

  const totalContributedUsd = [...contributed.values()].reduce((a, b) => a + b, 0);
  const totalWithdrawnUsd = [...withdrawn.values()].reduce((a, b) => a + b, 0);
  const netCapital = totalContributedUsd - totalWithdrawnUsd;

  const positions: OperatorPosition[] = operators.map((op) => {
    const u = units.get(op.id) ?? 0;
    const c = contributed.get(op.id) ?? 0;
    const w = withdrawn.get(op.id) ?? 0;
    const value = u * navPerUnit;
    return {
      operator: op,
      units: u,
      contributedUsd: c,
      withdrawnUsd: w,
      valueUsd: value,
      pnlUsd: value - (c - w),
      share: unitsOutstanding > 0 ? u / unitsOutstanding : 0,
    };
  });

  return {
    navUsd,
    navPerUnit,
    unitsOutstanding,
    totalContributedUsd,
    totalWithdrawnUsd,
    pnlUsd: navUsd - netCapital,
    pnlPct: netCapital > 0 ? (navUsd - netCapital) / netCapital : 0,
    positions,
    funded: unitsOutstanding > 0,
  };
}
