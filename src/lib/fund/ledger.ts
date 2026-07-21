/**
 * Capital ledger — deposits, withdrawals, and the NAV they imply.
 *
 * **NAV is derived, never typed.** It was a number in the config, which meant
 * it could say anything and never moved on its own. That is fine for a
 * placeholder and useless for tracking performance: a NAV you set by hand
 * cannot compound, cannot be wrong in a way you would notice, and quietly
 * decouples from what the book is actually worth.
 *
 * So:
 *
 *     NAV = (deposits − withdrawals) + realised P&L + unrealised P&L
 *           + funding received − fees paid
 *
 * Every term on the right comes from a recorded event or a replayed fill. If
 * the number moves, something happened, and you can find out what.
 *
 * **Simulated vs real is a first-class property of every event**, not a global
 * mode. A ledger that mixes them is worse than useless — it produces a track
 * record you cannot defend, and the whole point of paper trading is to build a
 * record you *can* defend before risking anything. Mixed ledgers are reported
 * as mixed and never silently summed into one headline.
 */

import { appendLog, readLog } from "@/lib/store/kv";
import { OPERATORS, type Operator } from "@/lib/fund/operators";

export const CAPITAL_LOG = "capital_events";

export type CapitalNature = "simulated" | "real";

export type CapitalEvent = {
  id: string;
  ts: number;
  operatorId: string;
  type: "deposit" | "withdrawal";
  /** Always positive; direction comes from `type`. */
  amountUsd: number;
  /**
   * Whether this is real money or a hypothetical.
   *
   * Per-event rather than a global switch, because the realistic path is a
   * simulated book that later takes a real deposit — and at that moment the
   * history must stay honest about which is which.
   */
  nature: CapitalNature;
  /** NAV per unit at the time, which is what decides how many units it buys. */
  navPerUnitAtEvent: number;
  /** Units issued (deposit) or redeemed (withdrawal). */
  unitsDelta: number;
  note: string | null;
};

export const INITIAL_NAV_PER_UNIT = 1;

export async function readCapitalEvents(): Promise<CapitalEvent[]> {
  try {
    const events = await readLog<CapitalEvent>(CAPITAL_LOG);
    return events.sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

export type LedgerTotals = {
  depositedUsd: number;
  withdrawnUsd: number;
  netContributedUsd: number;
  unitsOutstanding: number;
};

/**
 * Replay events into totals.
 *
 * Replayed rather than cached, for the same reason positions are: a stored
 * unit count that drifts from its own event log is a dispute nobody can settle.
 */
export function replayLedger(
  events: CapitalEvent[],
  nature?: CapitalNature,
): LedgerTotals {
  const relevant = nature ? events.filter((e) => e.nature === nature) : events;

  let depositedUsd = 0;
  let withdrawnUsd = 0;
  let unitsOutstanding = 0;

  for (const e of relevant) {
    if (e.type === "deposit") {
      depositedUsd += e.amountUsd;
      unitsOutstanding += e.unitsDelta;
    } else {
      withdrawnUsd += e.amountUsd;
      unitsOutstanding -= e.unitsDelta;
    }
  }

  return {
    depositedUsd,
    withdrawnUsd,
    netContributedUsd: depositedUsd - withdrawnUsd,
    unitsOutstanding,
  };
}

export type TradingPnl = {
  realisedUsd: number;
  unrealisedUsd: number;
  fundingUsd: number;
  feesUsd: number;
  /** Realised + unrealised + funding − fees. */
  totalUsd: number;
};

export const NO_PNL: TradingPnl = {
  realisedUsd: 0,
  unrealisedUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  totalUsd: 0,
};

export type FundNav = {
  /** The number everything else sizes against. */
  navUsd: number;
  netContributedUsd: number;
  pnl: TradingPnl;
  unitsOutstanding: number;
  navPerUnit: number;
  /** Return on net capital contributed. Null when nothing was contributed. */
  returnPct: number | null;
  funded: boolean;
  /** True when the ledger contains both simulated and real events. */
  mixed: boolean;
  nature: CapitalNature | "mixed" | "none";
};

/**
 * The fund's NAV, derived.
 *
 * `navPerUnit` is what makes contribution timing fair: a deposit made after a
 * profitable month buys fewer units, so it does not dilute the gain that
 * happened before it arrived.
 */
export function computeNav(events: CapitalEvent[], pnl: TradingPnl = NO_PNL): FundNav {
  const totals = replayLedger(events);
  const navUsd = totals.netContributedUsd + pnl.totalUsd;

  const natures = new Set(events.map((e) => e.nature));
  const mixed = natures.size > 1;

  return {
    navUsd,
    netContributedUsd: totals.netContributedUsd,
    pnl,
    unitsOutstanding: totals.unitsOutstanding,
    navPerUnit:
      totals.unitsOutstanding > 0 ? navUsd / totals.unitsOutstanding : INITIAL_NAV_PER_UNIT,
    returnPct:
      totals.netContributedUsd > 0 ? pnl.totalUsd / totals.netContributedUsd : null,
    funded: totals.unitsOutstanding > 0,
    mixed,
    nature: natures.size === 0 ? "none" : mixed ? "mixed" : [...natures][0],
  };
}

export type OperatorStake = {
  operator: Operator;
  units: number;
  depositedUsd: number;
  withdrawnUsd: number;
  valueUsd: number;
  pnlUsd: number;
  share: number;
};

export function operatorStakes(
  events: CapitalEvent[],
  nav: FundNav,
  operators: Operator[] = OPERATORS,
): OperatorStake[] {
  return operators.map((operator) => {
    const mine = events.filter((e) => e.operatorId === operator.id);
    const t = replayLedger(mine);
    const valueUsd = t.unitsOutstanding * nav.navPerUnit;

    return {
      operator,
      units: t.unitsOutstanding,
      depositedUsd: t.depositedUsd,
      withdrawnUsd: t.withdrawnUsd,
      valueUsd,
      pnlUsd: valueUsd - t.netContributedUsd,
      share: nav.unitsOutstanding > 0 ? t.unitsOutstanding / nav.unitsOutstanding : 0,
    };
  });
}

export type RecordResult =
  | { ok: true; event: CapitalEvent; nav: FundNav }
  | { ok: false; error: string };

/**
 * Record a deposit or withdrawal.
 *
 * Units are priced at the CURRENT NAV per unit, computed before the event is
 * applied. Pricing after would let a deposit buy units at a price it helped
 * set, which is how contribution timing turns into an unfair split.
 */
export async function recordCapitalEvent(input: {
  operatorId: string;
  type: "deposit" | "withdrawal";
  amountUsd: number;
  nature: CapitalNature;
  note?: string;
  pnl?: TradingPnl;
}): Promise<RecordResult> {
  const { operatorId, type, amountUsd, nature, note, pnl = NO_PNL } = input;

  if (!OPERATORS.some((o) => o.id === operatorId)) {
    return { ok: false, error: `Unknown operator: ${operatorId}` };
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { ok: false, error: "Amount must be a positive number" };
  }

  const events = await readCapitalEvents();
  const navBefore = computeNav(events, pnl);

  // Mixing real and simulated capital in one pool makes the track record
  // indefensible — you could no longer say which returns were earned with
  // money at risk. Refused rather than warned about.
  if (events.length > 0 && navBefore.nature !== "none" && navBefore.nature !== nature) {
    return {
      ok: false,
      error:
        `This ledger holds ${navBefore.nature} capital and you are adding ${nature}. ` +
        `Mixing them produces a track record that cannot be defended — reset the ` +
        `book first, or keep them separate.`,
    };
  }

  const navPerUnit = navBefore.navPerUnit;
  const unitsDelta = amountUsd / navPerUnit;

  if (type === "withdrawal") {
    const stakes = operatorStakes(events, navBefore);
    const mine = stakes.find((s) => s.operator.id === operatorId);
    if (!mine || unitsDelta > mine.units + 1e-9) {
      return {
        ok: false,
        error: `Withdrawal of $${amountUsd.toFixed(2)} exceeds this operator's holding of $${(mine?.valueUsd ?? 0).toFixed(2)}`,
      };
    }
  }

  const event: CapitalEvent = {
    id: `cap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    ts: Date.now(),
    operatorId,
    type,
    amountUsd,
    nature,
    navPerUnitAtEvent: navPerUnit,
    unitsDelta,
    note: note?.trim() || null,
  };

  await appendLog(CAPITAL_LOG, [event]);

  return { ok: true, event, nav: computeNav([...events, event], pnl) };
}

/** Wipe the ledger. Deliberate action only — hence the explicit name. */
export async function resetLedger(): Promise<void> {
  const { clearLog } = await import("@/lib/store/kv");
  await clearLog(CAPITAL_LOG);
}
