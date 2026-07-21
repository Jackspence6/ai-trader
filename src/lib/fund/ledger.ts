/**
 * Capital ledger — deposits, withdrawals, and the NAV they imply.
 *
 * The fund is wholly owned by Musket Goose. There are no fractional stakes and
 * no members, so this ledger tracks **one balance**, not a cap table.
 *
 * **NAV is derived, never typed:**
 *
 *     NAV = (deposits − withdrawals) + realised + unrealised + funding − fees
 *
 * Every term comes from a recorded event or a replayed fill, so if the number
 * moves, something happened and you can find out what. A hand-set NAV cannot
 * compound and quietly decouples from what the book is worth.
 *
 * **The performance index** is the one piece kept from the unit model. Units
 * change only when capital moves, so NAV-per-unit isolates trading performance
 * from deposits — it is a time-weighted return. Without it, adding $5,000 looks
 * identical to earning $5,000 on the balance alone, which is the single most
 * misleading thing a fund balance can do.
 *
 * **Simulated vs real is a property of each event**, not a global mode, and the
 * two cannot be mixed. A blended ledger produces a track record where you can
 * no longer say which returns were earned with money at risk — which is exactly
 * what paper trading exists to establish.
 */

import { appendLog, readLog } from "@/lib/store/kv";

export const CAPITAL_LOG = "capital_events";

export type CapitalNature = "simulated" | "real";

export type CapitalEvent = {
  id: string;
  ts: number;
  type: "deposit" | "withdrawal";
  /** Always positive; direction comes from `type`. */
  amountUsd: number;
  nature: CapitalNature;
  /** Index level at the time, which is what the unit maths prices against. */
  navPerUnitAtEvent: number;
  /** Change in the notional unit count. Drives the performance index only. */
  unitsDelta: number;
  note: string | null;
};

/** The performance index starts at 1.0000, so it reads directly as a multiple. */
export const INITIAL_NAV_PER_UNIT = 1;

export async function readCapitalEvents(): Promise<CapitalEvent[]> {
  try {
    return (await readLog<CapitalEvent>(CAPITAL_LOG)).sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

export type LedgerTotals = {
  depositedUsd: number;
  withdrawnUsd: number;
  netContributedUsd: number;
  /** Notional units. Exists to compute the performance index, nothing else. */
  unitsOutstanding: number;
};

/**
 * Replay events into totals.
 *
 * Replayed rather than cached, for the same reason positions are: a stored
 * total that drifts from its own event log is a number nobody can reconcile.
 */
export function replayLedger(events: CapitalEvent[]): LedgerTotals {
  let depositedUsd = 0;
  let withdrawnUsd = 0;
  let unitsOutstanding = 0;

  for (const e of events) {
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
  /** The balance everything else sizes against. */
  navUsd: number;
  netContributedUsd: number;
  depositedUsd: number;
  withdrawnUsd: number;
  pnl: TradingPnl;
  /**
   * Time-weighted performance index, starting at 1.0000.
   *
   * Moves only on trading P&L — deposits and withdrawals issue or redeem units
   * at the current level and therefore leave it unchanged. 1.05 means the
   * strategy is up 5% regardless of how much capital passed through.
   */
  performanceIndex: number;
  /** Index − 1, i.e. cumulative time-weighted return. */
  twrPct: number;
  /** Simple return on net capital in. Null when nothing was contributed. */
  returnOnCapitalPct: number | null;
  unitsOutstanding: number;
  funded: boolean;
  mixed: boolean;
  nature: CapitalNature | "mixed" | "none";
};

export function computeNav(events: CapitalEvent[], pnl: TradingPnl = NO_PNL): FundNav {
  const totals = replayLedger(events);
  const navUsd = totals.netContributedUsd + pnl.totalUsd;

  const natures = new Set(events.map((e) => e.nature));
  const mixed = natures.size > 1;

  const performanceIndex =
    totals.unitsOutstanding > 0 ? navUsd / totals.unitsOutstanding : INITIAL_NAV_PER_UNIT;

  return {
    navUsd,
    netContributedUsd: totals.netContributedUsd,
    depositedUsd: totals.depositedUsd,
    withdrawnUsd: totals.withdrawnUsd,
    pnl,
    performanceIndex,
    twrPct: performanceIndex - 1,
    returnOnCapitalPct:
      totals.netContributedUsd > 0 ? pnl.totalUsd / totals.netContributedUsd : null,
    unitsOutstanding: totals.unitsOutstanding,
    funded: totals.netContributedUsd > 0,
    mixed,
    nature: natures.size === 0 ? "none" : mixed ? "mixed" : [...natures][0],
  };
}

export type RecordResult =
  | { ok: true; event: CapitalEvent; nav: FundNav }
  | { ok: false; error: string };

/**
 * Record a deposit or withdrawal.
 *
 * Units are priced at the index level computed *before* the event is applied.
 * Pricing after would let a deposit move the index it was priced against,
 * which would corrupt the performance series with capital flows — the exact
 * thing the index exists to exclude.
 */
export async function recordCapitalEvent(input: {
  type: "deposit" | "withdrawal";
  amountUsd: number;
  nature: CapitalNature;
  note?: string;
  pnl?: TradingPnl;
}): Promise<RecordResult> {
  const { type, amountUsd, nature, note, pnl = NO_PNL } = input;

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { ok: false, error: "Amount must be a positive number" };
  }

  const events = await readCapitalEvents();
  const navBefore = computeNav(events, pnl);

  if (events.length > 0 && navBefore.nature !== "none" && navBefore.nature !== nature) {
    return {
      ok: false,
      error:
        `This ledger holds ${navBefore.nature} capital and you are adding ${nature}. ` +
        `Mixing them produces a track record that cannot be defended — reset the ` +
        `book first, or keep them separate.`,
    };
  }

  if (type === "withdrawal" && amountUsd > navBefore.navUsd + 1e-9) {
    return {
      ok: false,
      error: `Withdrawal of $${amountUsd.toFixed(2)} exceeds the fund balance of $${navBefore.navUsd.toFixed(2)}`,
    };
  }

  const event: CapitalEvent = {
    id: `cap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    ts: Date.now(),
    type,
    amountUsd,
    nature,
    navPerUnitAtEvent: navBefore.performanceIndex,
    unitsDelta: amountUsd / navBefore.performanceIndex,
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
