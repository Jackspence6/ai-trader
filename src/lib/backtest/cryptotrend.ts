/**
 * H1 · crypto trend backtest — Donchian breakout with an ATR trailing stop.
 *
 * The book's structural gap this investigates: every funded strategy is
 * carry, so the portfolio has zero exposure to the one thing crypto reliably
 * does that FX does not — trend hard. F2 trend failed on 7%-vol FX pairs
 * that range for months; whether the same discipline earns on 60%-vol crypto
 * is an empirical question, and the Systematic sleeve (H1) has been sitting
 * defined-but-unfunded waiting for exactly this evidence.
 *
 * The rules, long-only and deliberately classic (no tuning cleverness):
 *   - ENTER long when the close breaks above the N-day Donchian upper band.
 *   - EXIT on the ATR trailing stop (highest close since entry minus k×ATR)
 *     or a close below the M-day lower band, whichever comes first.
 *   - Long-only spot, no leverage: at this account size shorting adds margin
 *     cost and liquidation risk to a hypothesis that is not yet proven.
 *
 * Costs are the live model: Binance spot taker round trip charged in full at
 * entry. Uses the calc-core indicators (donchian, atr) — the same functions
 * any live implementation would run.
 */

import { atr, donchian } from "@/lib/calc/indicators";
import type { CarryBacktest } from "./carry";

export type Ohlc = { t: number; o: number; h: number; l: number; c: number };

export type CryptoTrendParams = {
  /** Breakout lookback (entry band). */
  entryN: number;
  /** Exit band lookback, conventionally shorter. */
  exitN: number;
  /** ATR multiple for the trailing stop. */
  atrK: number;
  /** Round-trip execution cost as a fraction of notional. */
  roundTripCostFraction: number;
};

export type CryptoTrendExtra = {
  exits: { stop: number; band: number };
  /** Buy-and-hold return over the same window, the benchmark to beat or
   * complement — trend must justify its costs against just holding. */
  buyHoldReturn: number;
};

export function backtestCryptoTrend(
  series: Ohlc[],
  params: CryptoTrendParams,
): { bt: CarryBacktest; extra: CryptoTrendExtra } {
  const highs = series.map((p) => p.h);
  const lows = series.map((p) => p.l);
  const closes = series.map((p) => p.c);

  const { upper } = donchian(highs, lows, params.entryN);
  const { lower } = donchian(highs, lows, params.exitN);
  const atrs = atr(highs, lows, closes, 14);

  const trades: CarryBacktest["trades"] = [];
  const equity: { t: number; cumReturn: number }[] = [];
  const intervalReturns: number[] = [];

  let cum = 0;
  let inPos = false;
  let entryT = 0;
  let entryIndex = 0;
  let tradePnl = 0;
  let highWater = 0; // highest close since entry, for the trailing stop
  let intervalsHeld = 0;
  const exits = { stop: 0, band: 0 };

  for (let i = 0; i < series.length; i++) {
    let intervalReturn = 0;

    if (inPos && i > 0) {
      const day = closes[i] / closes[i - 1] - 1;
      intervalReturn += day;
      tradePnl += day;
      intervalsHeld += 1;
      highWater = Math.max(highWater, closes[i]);

      const a = atrs[i];
      const trailStop = a !== null && closes[i] < highWater - params.atrK * a;
      const bandExit = lower[i] !== null && closes[i] < (lower[i] as number);

      if (trailStop || bandExit) {
        trades.push({
          entryT,
          exitT: series[i].t,
          intervals: i - entryIndex,
          fundingReturn: 0,
          netReturn: tradePnl,
          win: tradePnl > 0,
        });
        if (trailStop) exits.stop += 1;
        else exits.band += 1;
        inPos = false;
      }
    }

    if (!inPos && upper[i] !== null && closes[i] > (upper[i] as number)) {
      inPos = true;
      entryT = series[i].t;
      entryIndex = i;
      highWater = closes[i];
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
    extra: {
      exits,
      buyHoldReturn:
        closes.length > 1 ? closes[closes.length - 1] / closes[0] - 1 : 0,
    },
  };
}
