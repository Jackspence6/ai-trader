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
 *
 *     For single-venue funding carry the check is regime-aware where history is
 *     available: a lone negative print does not close a trade whose *median*
 *     funding over the window is still positive. The backtest was unambiguous
 *     on why — trades exited on single prints held ~2 days, never amortised
 *     their round-trip cost, and lost on every one. A single 8h interval of
 *     negative funding costs a couple of bp; re-entering costs a ~35bp round
 *     trip. Only when the regime itself has inverted is the carry actually over.
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

export type ExitReason =
  | "funding_inverted"
  | "spread_inverted"
  | "fx_carry_decayed"
  | "trend_flipped"
  | "trend_stopped"
  | "peg_restored"
  | "stop_loss";

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
  /**
   * Median annualised funding over the regime window, where history exists.
   * Confirms a funding-carry exit: a negative print with a positive median is
   * noise, not an inversion. Undefined (no history) falls back to exiting on
   * the print alone — the conservative behaviour when we cannot tell.
   */
  fundingMedianApr?: (venue: string, asset: string) => number | undefined;
  /** Current base/quote of an FX pair symbol, for its live carry. */
  fxPair: (symbol: string) => { base: string; quote: string } | undefined;
  /** Current trend direction per FX pair, for trend-position exits. */
  fxTrend?: (symbol: string) => "long" | "short" | "flat" | undefined;
  /** Volatility-stop distance per FX pair, as a fraction of notional. */
  fxTrendStop?: (symbol: string) => number | undefined;
  /**
   * Current below-par discount for a stable asset (L3), as a fraction.
   * Returning a value marks the asset AS a stable; ≤ the exit threshold means
   * the peg has restored and the trade is complete.
   */
  stableDiscount?: (asset: string) => number | undefined;
  swapMarkupApr?: number;
};

/** A peg trade is done once the discount has collapsed to dust. */
export const PEG_EXIT_DISCOUNT = 0.0002;

const REASON_LABELS: Record<ExitReason, string> = {
  funding_inverted: "Funding turned negative — carry now pays instead of receives",
  spread_inverted: "Funding spread inverted — the cross-venue edge is gone",
  fx_carry_decayed: "Net FX carry turned negative — differential no longer covers the swap",
  trend_flipped: "Trend signal reversed — the reason for the position is gone",
  trend_stopped: "Volatility stop — the move against exceeds the invalidation distance",
  peg_restored: "Peg restored — the discount this position bought is collected",
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

    // --- FX: single spot leg on the FX venue, rules split by mandate --------
    const fxLeg = legs.find((l) => l.venue === FX_VENUE);
    if (fxLeg) {
      if (sleeveId === "fx-trend") {
        // A trend position exists because the signal points its way; when the
        // signal reverses, the reason is gone. A signal that merely goes FLAT
        // is a range, not a reversal — the position rides it under its stop,
        // because re-entering on every wobble is how a trend book churns.
        const dir = ctx.fxTrend?.(fxLeg.asset);
        const held = fxLeg.qty > 0 ? "long" : "short";
        if (dir === (held === "long" ? "short" : "long")) {
          plans.push(plan("trend_flipped"));
          continue;
        }

        // Volatility stop, tighter than the generic backstop: the invalidation
        // distance the position was sized against.
        const stop = ctx.fxTrendStop?.(fxLeg.asset);
        const pnl = fxLeg.totalPnlUsd;
        const notional = Math.abs(fxLeg.notionalUsd);
        if (
          stop !== undefined &&
          stop > 0 &&
          pnl !== null &&
          notional > 0 &&
          pnl < -stop * notional
        ) {
          plans.push(plan("trend_stopped"));
        }
        continue;
      }

      // Carry mandate: exit when the net-of-swap differential goes negative.
      const pair = ctx.fxPair(fxLeg.asset);
      if (pair) {
        const differential = carryApr(pair.base, pair.quote);
        const signed = fxLeg.qty > 0 ? differential : -differential;
        const netCarry = signed - swap;
        if (netCarry < EXIT_FX_CARRY_APR) plans.push(plan("fx_carry_decayed"));
      }
      continue;
    }

    // --- stablecoin peg (L3): a long spot stable, sold when par returns -----
    const discount = ctx.stableDiscount?.(asset);
    if (discount !== undefined && legs.every((l) => l.market === "spot")) {
      const long = legs.find((l) => l.qty > 0);
      if (long && discount <= PEG_EXIT_DISCOUNT) {
        plans.push(plan("peg_restored"));
      }
      continue;
    }

    // --- crypto carry: perp leg(s) ------------------------------------------
    const perps = legs.filter((l) => l.market === "perp");

    if (perps.length === 1) {
      // Single-venue funding carry (L1): we short the perp to receive funding.
      // Exit needs the print to be negative AND, when a regime window exists,
      // the median too — one interval of negative funding is cheaper to sit
      // through than a round trip is to pay.
      const perp = perps[0];
      const f = ctx.fundingApr(String(perp.venue), perp.asset);
      if (f !== undefined && perp.qty < 0 && f < EXIT_FUNDING_APR) {
        const median = ctx.fundingMedianApr?.(String(perp.venue), perp.asset);
        if (median === undefined || median < EXIT_FUNDING_APR) {
          plans.push(plan("funding_inverted"));
        }
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
