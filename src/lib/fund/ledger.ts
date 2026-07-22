/**
 * Capital ledger — deposits, withdrawals, and the NAV they imply.
 *
 * The fund is wholly owned by Musket Goose. There are no fractional stakes and
 * no members, so this ledger tracks **balances**, not a cap table.
 *
 * **Two accounts.** Capital is split into a `crypto` book and a `forex` book,
 * because the two asset classes have completely different risk and the whole
 * point of holding both is to keep them separable — you want to see what each
 * is doing on its own, and fund them independently. Each account has its own
 * balance and its own NAV. A sleeve draws from the account matching its asset
 * class (`lib/portfolio/sleeves.ts`).
 *
 * **NAV is derived, never typed:**
 *
 *     NAV = (deposits − withdrawals) + realised + unrealised + funding − fees
 *
 * Every term comes from a recorded event or a replayed fill, so if the number
 * moves, something happened and you can find out what.
 *
 * **Deposits can be made in ZAR.** The operator funds in rands; the ledger
 * converts at the live rate *at the moment of deposit* and stores USD as the
 * canonical amount, while keeping the original ZAR figure and the rate used for
 * audit. USD is canonical because that is what the venues settle in — storing
 * ZAR would make every historical balance move whenever the rand moved, and we
 * would lose the ability to tell trading performance apart from currency drift.
 *
 * **The performance index** is kept from the unit model: units change only when
 * capital moves, so NAV-per-unit isolates trading performance from deposits. It
 * is a time-weighted return, per account.
 */

import { appendLog, readLog } from "@/lib/store/kv";

export const CAPITAL_LOG = "capital_events";

/** The two books capital is split across. */
export type FundAccount = "crypto" | "forex";

export const FUND_ACCOUNTS: { id: FundAccount; label: string; note: string }[] = [
  {
    id: "crypto",
    label: "Crypto",
    note: "High-volatility book — funding carry, spot accumulation, trend, dislocations.",
  },
  {
    id: "forex",
    label: "Forex",
    note: "Low-volatility, uncorrelated book — currency carry and trend. Steadies the whole.",
  },
];

export type CapitalNature = "simulated" | "real";

/** What was actually handed over, before conversion. Present on ZAR deposits. */
export type OriginalContribution = {
  currency: string;
  amount: number;
  /** USD per 1 unit of `currency` at the time — i.e. amount × rate = USD… no. */
  usdPerUnit: number;
};

export type CapitalEvent = {
  id: string;
  ts: number;
  /** Which book this moves. */
  account: FundAccount;
  type: "deposit" | "withdrawal";
  /** Canonical amount in USD, always positive. */
  amountUsd: number;
  nature: CapitalNature;
  /** The original currency/amount when funded in something other than USD. */
  original: OriginalContribution | null;
  /** Index level at the time — what the unit maths prices against. */
  navPerUnitAtEvent: number;
  /** Change in the notional unit count. Drives the performance index only. */
  unitsDelta: number;
  note: string | null;
};

export const INITIAL_NAV_PER_UNIT = 1;

export async function readCapitalEvents(): Promise<CapitalEvent[]> {
  try {
    const events = await readLog<CapitalEvent>(CAPITAL_LOG);
    // Defensive: any legacy event without an account is treated as crypto, so
    // an old record can never silently vanish from the totals.
    return events
      .map((e) => ({ ...e, account: (e.account ?? "crypto") as FundAccount }))
      .sort((a, b) => a.ts - b.ts);
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

/** Replay events into totals, optionally for a single account. */
export function replayLedger(events: CapitalEvent[], account?: FundAccount): LedgerTotals {
  const relevant = account ? events.filter((e) => e.account === account) : events;

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
  navUsd: number;
  netContributedUsd: number;
  depositedUsd: number;
  withdrawnUsd: number;
  pnl: TradingPnl;
  performanceIndex: number;
  twrPct: number;
  returnOnCapitalPct: number | null;
  unitsOutstanding: number;
  funded: boolean;
  mixed: boolean;
  nature: CapitalNature | "mixed" | "none";
};

/** Aggregate NAV from all events plus total P&L. */
export function computeNav(events: CapitalEvent[], pnl: TradingPnl = NO_PNL): FundNav {
  return navFrom(replayLedger(events), pnl, events);
}

/** NAV for one account, from that account's events and P&L. */
export function computeAccountNav(
  events: CapitalEvent[],
  account: FundAccount,
  pnl: TradingPnl = NO_PNL,
): FundNav {
  const accountEvents = events.filter((e) => e.account === account);
  return navFrom(replayLedger(accountEvents), pnl, accountEvents);
}

function navFrom(totals: LedgerTotals, pnl: TradingPnl, events: CapitalEvent[]): FundNav {
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
 * Record a deposit or withdrawal into one account.
 *
 * When `currency` is not USD, `usdPerUnit` converts it — the caller passes the
 * live rate, and the USD amount is computed and stored as canonical. Units are
 * priced at the index level computed BEFORE the event is applied, so a deposit
 * cannot move the index it was priced against.
 */
export async function recordCapitalEvent(input: {
  account: FundAccount;
  type: "deposit" | "withdrawal";
  /** Amount in `currency`. */
  amount: number;
  currency?: string;
  /** USD per 1 unit of `currency`. Required and > 0 when currency ≠ USD. */
  usdPerUnit?: number;
  nature: CapitalNature;
  note?: string;
  pnl?: TradingPnl;
}): Promise<RecordResult> {
  const { account, type, amount, currency = "USD", nature, note, pnl = NO_PNL } = input;

  if (!FUND_ACCOUNTS.some((a) => a.id === account)) {
    return { ok: false, error: `Unknown account: ${account}` };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive number" };
  }

  let amountUsd = amount;
  let original: OriginalContribution | null = null;

  if (currency !== "USD") {
    const rate = input.usdPerUnit;
    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      return {
        ok: false,
        error: `A live ${currency}/USD rate is required to convert a ${currency} deposit`,
      };
    }
    amountUsd = amount * rate;
    original = { currency, amount, usdPerUnit: rate };
  }

  const events = await readCapitalEvents();

  // Nature is a property of the whole ledger, not per account — mixing real and
  // simulated capital anywhere makes the track record indefensible.
  const ledgerNature = computeNav(events, pnl).nature;
  if (events.length > 0 && ledgerNature !== "none" && ledgerNature !== nature) {
    return {
      ok: false,
      error:
        `This ledger holds ${ledgerNature} capital and you are adding ${nature}. ` +
        `Mixing them produces a track record that cannot be defended — reset it first.`,
    };
  }

  const navBefore = computeAccountNav(events, account, pnl);

  if (type === "withdrawal" && amountUsd > navBefore.navUsd + 1e-9) {
    return {
      ok: false,
      error: `Withdrawal of $${amountUsd.toFixed(2)} exceeds the ${account} balance of $${navBefore.navUsd.toFixed(2)}`,
    };
  }

  const event: CapitalEvent = {
    id: `cap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    ts: Date.now(),
    account,
    type,
    amountUsd,
    nature,
    original,
    navPerUnitAtEvent: navBefore.performanceIndex,
    unitsDelta: amountUsd / navBefore.performanceIndex,
    note: note?.trim() || null,
  };

  await appendLog(CAPITAL_LOG, [event]);

  return {
    ok: true,
    event,
    nav: computeAccountNav([...events, event], account, pnl),
  };
}

/** Wipe the ledger. Deliberate action only — hence the explicit name. */
export async function resetLedger(): Promise<void> {
  const { clearLog } = await import("@/lib/store/kv");
  await clearLog(CAPITAL_LOG);
}
