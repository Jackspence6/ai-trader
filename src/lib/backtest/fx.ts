/**
 * FX book backtests — F2 trend and F1 carry on real daily history.
 *
 * Both FX strategies were trading paper capital with zero backtest, which is
 * exactly the gap that let L2 run as a structural loser: a strategy earned
 * live allocation on the strength of its scoring model, and the scoring model
 * had never met history. These replays close that gap for the forex book.
 *
 * Honesty rules, same as every backtest here:
 *   - The SIGNAL code is the live code. F2 calls `evaluateFxTrend` and
 *     `trendStopFraction` — the exact functions the scanner and exit manager
 *     run — on each day's prefix of closes. A backtest of a reimplementation
 *     validates the reimplementation, not the strategy.
 *   - Costs are the live cost model: the fx venue's fee schedule plus the
 *     per-pair modelled spread, charged in full at entry.
 *   - Carry accrues daily at the CURRENT policy-rate differential minus the
 *     broker swap markup. Historical rate paths are not modelled — the ECB/Fed
 *     were elsewhere three years ago — so multi-year carry components carry an
 *     explicit caveat rather than fabricated rate history.
 *   - Returns are on notional. Leverage is left to the reader.
 */

import { evaluateFxTrend, trendStopFraction } from "@/lib/calc/fxsignal";
import type { CarryBacktest } from "./carry";

export type FxDaily = { t: number; rate: number };

/** ECB fixes are business days — annualise daily stats on 252. */
export const FX_INTERVALS_PER_YEAR = 252;

export type FxTrendParams = {
  fast: number;
  slow: number;
  minStrengthPct: number;
  /** Round-trip execution cost as a fraction of notional. */
  roundTripCostFraction: number;
  /** Signed base−quote differential at current policy rates, annualised. */
  differentialApr: number;
  /** Broker swap markup, charged on held positions regardless of direction. */
  swapMarkupApr: number;
};

export type FxTrendExtra = {
  /** Return decomposition, both as fractions of notional. */
  priceReturn: number;
  carryReturn: number;
  exits: { flip: number; stop: number };
};

/**
 * Replay the live dual-MA trend rules over one pair's daily closes.
 *
 * Entry when the live signal engages; exit when it flips to the opposite side
 * (a FLAT signal holds — a range is not a reversal) or when the trade breaches
 * the live volatility stop. Carry on the held direction accrues daily: a trend
 * position pays or earns the differential exactly like a carry position does,
 * and ignoring that flatters shorts in high-carry pairs.
 */
export function backtestFxTrend(
  series: FxDaily[],
  params: FxTrendParams,
): { bt: CarryBacktest; extra: FxTrendExtra } {
  const closes = series.map((p) => p.rate);

  const trades: CarryBacktest["trades"] = [];
  const equity: { t: number; cumReturn: number }[] = [];
  const intervalReturns: number[] = [];

  let cum = 0;
  let dir = 0; // +1 long, −1 short, 0 flat
  let entryT = 0;
  let entryIndex = 0;
  let tradePnl = 0; // price + carry − cost, as a fraction of notional
  let carryAcc = 0;
  let intervalsHeld = 0;
  let priceReturn = 0;
  let carryReturn = 0;
  const exits = { flip: 0, stop: 0 };

  const closeTrade = (i: number, why: "flip" | "stop") => {
    trades.push({
      entryT,
      exitT: series[i].t,
      intervals: i - entryIndex,
      fundingReturn: carryAcc,
      netReturn: tradePnl,
      win: tradePnl > 0,
    });
    exits[why] += 1;
    dir = 0;
  };

  for (let i = 0; i < series.length; i++) {
    let intervalReturn = 0;

    // The live signal, on exactly the data live would have had that day.
    const trend = evaluateFxTrend("PAIR", closes.slice(0, i + 1), {
      fast: params.fast,
      slow: params.slow,
      minStrengthPct: params.minStrengthPct,
    });

    if (dir !== 0 && i > 0) {
      // Accrue the day: price move plus signed carry, minus the swap markup.
      const dayPrice = dir * (closes[i] / closes[i - 1] - 1);
      const dayCarry =
        (dir * params.differentialApr - params.swapMarkupApr) / 365;
      intervalReturn += dayPrice + dayCarry;
      tradePnl += dayPrice + dayCarry;
      carryAcc += dayCarry;
      priceReturn += dayPrice;
      carryReturn += dayCarry;
      intervalsHeld += 1;

      const flipped =
        trend.direction !== "flat" &&
        (trend.direction === "long" ? 1 : -1) === -dir;
      const stop =
        trend.annualisedVol !== null &&
        tradePnl < -trendStopFraction(trend.annualisedVol);

      if (stop) closeTrade(i, "stop");
      else if (flipped) closeTrade(i, "flip");
    }

    if (dir === 0 && trend.engaged && trend.direction !== "flat") {
      dir = trend.direction === "long" ? 1 : -1;
      entryT = series[i].t;
      entryIndex = i;
      carryAcc = 0;
      // Charge the whole round trip up front, as every backtest here does.
      tradePnl = -params.roundTripCostFraction;
      intervalReturn -= params.roundTripCostFraction;
    }

    cum += intervalReturn;
    intervalReturns.push(intervalReturn);
    equity.push({ t: series[i].t, cumReturn: cum });
  }

  return {
    bt: {
      trades,
      equity,
      intervalReturns,
      intervalsHeld,
      intervalsTotal: series.length,
    },
    extra: { priceReturn, carryReturn, exits },
  };
}

export type FxCarryParams = {
  /** Signed base−quote differential at current policy rates, annualised. */
  differentialApr: number;
  swapMarkupApr: number;
  /** Net carry floor below which the pair is not entered at all. */
  minNetApr: number;
  roundTripCostFraction: number;
  /** The live backstop: close a trade down more than this, then re-enter. */
  stopLossPct: number;
};

export type FxCarryExtra = {
  /** Which way the differential says to hold, or 0 when not viable. */
  direction: 1 | -1 | 0;
  netCarryApr: number;
  priceReturn: number;
  carryReturn: number;
  stops: number;
};

/**
 * Replay the live F1 rules: hold the differential-earning direction while the
 * net-of-swap carry clears the floor. With static policy rates the direction
 * never flips mid-replay, so the honest question this answers is the one that
 * actually decides F1's fate — **does price risk swamp the carry?** The carry
 * component is deterministic; the price component is history.
 *
 * The live stop backstop is modelled faithfully including its failure mode:
 * a stopped trade re-enters the next day while the carry is still viable,
 * paying a fresh round trip — exactly what the live loop would do.
 */
export function backtestFxCarry(
  series: FxDaily[],
  params: FxCarryParams,
): { bt: CarryBacktest; extra: FxCarryExtra } {
  const grossApr = Math.abs(params.differentialApr);
  const netCarryApr = grossApr - params.swapMarkupApr;
  const direction: 1 | -1 | 0 =
    netCarryApr < params.minNetApr ? 0 : params.differentialApr > 0 ? 1 : -1;

  const trades: CarryBacktest["trades"] = [];
  const equity: { t: number; cumReturn: number }[] = [];
  const intervalReturns: number[] = [];

  let cum = 0;
  let inPosition = false;
  let entryT = 0;
  let entryIndex = 0;
  let tradePnl = 0;
  let carryAcc = 0;
  let intervalsHeld = 0;
  let priceReturn = 0;
  let carryReturn = 0;
  let stops = 0;

  for (let i = 0; i < series.length; i++) {
    let intervalReturn = 0;

    if (inPosition && i > 0) {
      const dayPrice = direction * (series[i].rate / series[i - 1].rate - 1);
      const dayCarry = netCarryApr / 365;
      intervalReturn += dayPrice + dayCarry;
      tradePnl += dayPrice + dayCarry;
      carryAcc += dayCarry;
      priceReturn += dayPrice;
      carryReturn += dayCarry;
      intervalsHeld += 1;

      if (tradePnl < -params.stopLossPct) {
        trades.push({
          entryT,
          exitT: series[i].t,
          intervals: i - entryIndex,
          fundingReturn: carryAcc,
          netReturn: tradePnl,
          win: false,
        });
        stops += 1;
        inPosition = false;
      }
    }

    if (!inPosition && direction !== 0) {
      inPosition = true;
      entryT = series[i].t;
      entryIndex = i;
      carryAcc = 0;
      tradePnl = -params.roundTripCostFraction;
      intervalReturn -= params.roundTripCostFraction;
    }

    cum += intervalReturn;
    intervalReturns.push(intervalReturn);
    equity.push({ t: series[i].t, cumReturn: cum });
  }

  // A position still open at the end is marked in the equity curve but not
  // counted as a completed trade — same convention as the carry backtest.
  return {
    bt: {
      trades,
      equity,
      intervalReturns,
      intervalsHeld,
      intervalsTotal: series.length,
    },
    extra: { direction, netCarryApr, priceReturn, carryReturn, stops },
  };
}
