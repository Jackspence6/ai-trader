/**
 * Position exits — the other half of the trading loop.
 *
 * The scanner opens positions; without this, nothing ever closes them, and a
 * carry whose thesis has broken just sits there bleeding while a converged or
 * inverted trade ties up capital that a live opportunity could use. A system
 * that can only open is not testing a strategy — a real carry desk closes the
 * moment the reason it was on stops being true.
 *
 * Exits are evaluated per **trade**, not per leg. A funding carry is one trade
 * held as two legs (long spot, short perp); closing one and not the other turns
 * a hedged position into a naked one, which is the single most dangerous thing
 * this file could get wrong. So legs are grouped by (sleeve, asset) and a trade
 * exits as a whole.
 *
 * The rules, and why each threshold sits where it does:
 *
 *   - **Thesis broken.** A funding carry earns because funding is positive; when
 *     it turns negative the short leg pays instead of receiving, so the trade is
 *     closed. Same for an FX carry whose rate differential has decayed past the
 *     swap cost. Entry needed a healthy positive edge and exit only triggers
 *     once it has gone outright negative — that wide band is deliberate
 *     hysteresis, so a rate wobbling around zero does not churn the book.
 *   - **Stop loss.** A delta-neutral carry should barely move; a large loss means
 *     the hedge has slipped or a leg gapped, and the safe response is out. This
 *     is a backstop, not the primary exit.
 */

import { carryApr } from "@/lib/market/forex";
import { DEFAULT_SWAP_MARKUP_APR } from "@/lib/calc/fxsignal";
import { FX_VENUE } from "@/lib/market/fxbook";
import type { MarkedPosition } from "@/lib/portfolio/positions";

/** Close a funding carry once funding is no longer positive (was entered rich). */
export const EXIT_FUNDING_APR = 0;
/** Close an FX carry once its net-of-swap carry turns negative. */
export const EXIT_FX_CARRY_APR = 0;
/** Backstop: close any trade down more than this share of its entry notional. */
export const STOP_LOSS_PCT = 0.12;

export type ExitReason = "funding_inverted" | "spread_inverted" | "fx_carry_decayed" | "stop_loss";

export type ExitPlan = {
  key: string;
  sleeveId: string;
  asset: string;
  /** The open legs to close, as a unit. */
  legs: MarkedPosition[];
  reason: ExitReason;
  detail: string;
};

export type ExitContext = {
  /** Current annualised funding for a perp, by `${venue}:${asset}`. */
  fundingApr: (venue: string, asset: string) => number | undefined;
  /** Current base/quote of an FX pair symbol, for its live carry. */
  fxPair: (symbol: string) => { base: string; quote: string } | undefined;
  swapMarkupApr?: number;
};

const REASON_LABELS: Record<ExitReason, string> = {
  funding_inverted: "Funding turned negative — carry now pays instead of receives",
  spread_inverted: "Funding spread inverted — the cross-venue edge is gone",
  fx_carry_decayed: "Net FX carry turned negative — differential no longer covers the swap",
  stop_loss: "Stop loss — trade down past its backstop",
};

/**
 * Decide which open trades to close.
 *
 * Pure: it reads live signals through the injected `ctx` accessors and returns
 * the plan, so the pass owns execution and this stays testable with plain data.
 */
export function evaluateExits(marked: MarkedPosition[], ctx: ExitContext): ExitPlan[] {
  const swap = ctx.swapMarkupApr ?? DEFAULT_SWAP_MARKUP_APR;

  // Group open legs into trades by (sleeve, asset).
  const groups = new Map<string, MarkedPosition[]>();
  for (const p of marked) {
    if (p.qty === 0) continue;
    const key = `${p.sleeveId}:${p.asset}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }

  const plans: ExitPlan[] = [];

  for (const [key, legs] of groups) {
    const [sleeveId, asset] = key.split(":");
    const plan = (reason: ExitReason): ExitPlan => ({
      key,
      sleeveId,
      asset,
      legs,
      reason,
      detail: REASON_LABELS[reason],
    });

    // --- stop loss first: it is the most urgent and shape-independent -------
    const anyUnpriced = legs.some((l) => l.totalPnlUsd === null);
    if (!anyUnpriced) {
      const groupPnl = legs.reduce((a, l) => a + (l.totalPnlUsd ?? 0), 0);
      const tradeNotional = Math.max(...legs.map((l) => Math.abs(l.notionalUsd)));
      if (tradeNotional > 0 && groupPnl < -STOP_LOSS_PCT * tradeNotional) {
        plans.push(plan("stop_loss"));
        continue;
      }
    }

    // --- FX carry: single spot leg on the FX venue --------------------------
    const fxLeg = legs.find((l) => l.venue === FX_VENUE);
    if (fxLeg) {
      const pair = ctx.fxPair(fxLeg.asset);
      if (pair) {
        const differential = carryApr(pair.base, pair.quote);
        const signed = fxLeg.qty > 0 ? differential : -differential;
        const netCarry = signed - swap;
        if (netCarry < EXIT_FX_CARRY_APR) plans.push(plan("fx_carry_decayed"));
      }
      continue;
    }

    // --- crypto carry: perp leg(s) ------------------------------------------
    const perps = legs.filter((l) => l.market === "perp");

    if (perps.length === 1) {
      // Single-venue funding carry (L1): we short the perp to receive funding.
      const perp = perps[0];
      const f = ctx.fundingApr(String(perp.venue), perp.asset);
      if (f !== undefined && perp.qty < 0 && f < EXIT_FUNDING_APR) {
        plans.push(plan("funding_inverted"));
      }
      continue;
    }

    if (perps.length >= 2) {
      // Cross-venue funding spread (L2): short the rich venue, long the cheap
      // one. Net funding is the spread; exit when it inverts.
      const short = perps.find((l) => l.qty < 0);
      const long = perps.find((l) => l.qty > 0);
      if (short && long) {
        const fShort = ctx.fundingApr(String(short.venue), short.asset);
        const fLong = ctx.fundingApr(String(long.venue), long.asset);
        if (fShort !== undefined && fLong !== undefined && fShort - fLong < EXIT_FUNDING_APR) {
          plans.push(plan("spread_inverted"));
        }
      }
    }
  }

  return plans;
}
