/**
 * H1 · crypto trend scan — Donchian breakout, long-only spot.
 *
 * Backed by the cryptotrend backtest: positive in every tested parameter
 * cell over ~2.7 years (portfolio +38–47%), including on assets where
 * buy-and-hold lost. Its role in the book is the directional stream the
 * all-carry portfolio lacks — disciplined exposure with mechanical exits,
 * not a promise to beat holding in a bull market.
 *
 * Long-only spot, no leverage: shorting adds margin and liquidation risk to
 * a hypothesis proven only on the long side. Sizing goes through the same
 * trend gate F2 uses — bounded loss at a real invalidation, never an
 * invented "edge in bps".
 */

import { atr, donchian, logReturns } from "@/lib/calc/indicators";
import { evaluateTrendGate } from "@/lib/calc/gate";
import type { resolveTier } from "@/lib/calc/tiers";
import { computePortfolio, sleeveForStrategy } from "@/lib/portfolio/sleeves";
import type { SleeveContext } from "@/lib/calc/gate";
import type { Candle } from "@/lib/market/venues";
import type { EngineConfig } from "./config";
import type { ScoredOpportunity } from "./scanner";

/** Entry breakout lookback / exit band / ATR stop multiple — the slowest
 * tested cell, chosen for fewest round trips (robustness came from the whole
 * grid being positive, not from this cell winning). */
export const H1_ENTRY_N = 100;
export const H1_EXIT_N = 30;
export const H1_ATR_K = 4;
/** Loss at the stop as a fraction of the sleeve, matching F2's discipline. */
export const H1_RISK_PER_TRADE = 0.01;

/**
 * Exit state for an OPEN H1 position: the two exits the backtest validated —
 * close below the exit band, or close below (highest close since entry −
 * k×ATR). The high-water mark is recomputed from candles since entry, so no
 * per-position state needs persisting.
 */
export function cryptoTrendExitState(
  candles: Candle[],
  openedAt: number,
): { bandExit: boolean; trailExit: boolean } | null {
  const st = cryptoTrendState(candles);
  if (!st) return null;
  const closes = candles.filter((c) => c.t >= openedAt).map((c) => c.c);
  const last = candles[candles.length - 1].c;
  const highs2 = candles.map((c) => c.h);
  const lows2 = candles.map((c) => c.l);
  const a = atr(highs2, lows2, candles.map((c) => c.c), 14)[candles.length - 1];
  const highWater = closes.length > 0 ? Math.max(...closes) : last;
  return {
    bandExit: st.bandExit,
    trailExit: a !== null && last < highWater - H1_ATR_K * a,
  };
}

export type CryptoTrendState = {
  breakout: boolean;
  /** Close below the exit band — the live exit signal. */
  bandExit: boolean;
  stopDistanceFraction: number;
  annualisedVol: number | null;
};

/** Evaluate the H1 state for one asset from its daily candles. */
export function cryptoTrendState(candles: Candle[]): CryptoTrendState | null {
  if (candles.length < H1_ENTRY_N + 2) return null;
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const closes = candles.map((c) => c.c);
  const i = candles.length - 1;

  const { upper } = donchian(highs, lows, H1_ENTRY_N);
  const { lower } = donchian(highs, lows, H1_EXIT_N);
  const a = atr(highs, lows, closes, 14)[i];

  const rets = logReturns(closes).filter((r): r is number => r !== null).slice(-90);
  const mean = rets.reduce((x, y) => x + y, 0) / Math.max(rets.length, 1);
  const variance =
    rets.length < 2
      ? 0
      : rets.reduce((x, r) => x + (r - mean) ** 2, 0) / (rets.length - 1);
  const vol = rets.length < 2 ? null : Math.sqrt(variance) * Math.sqrt(365);

  return {
    breakout: upper[i] !== null && closes[i] > (upper[i] as number),
    bandExit: lower[i] !== null && closes[i] < (lower[i] as number),
    stopDistanceFraction: a !== null && closes[i] > 0 ? (H1_ATR_K * a) / closes[i] : 0,
    annualisedVol: vol,
  };
}

export type CryptoTrendScanContext = {
  config: EngineConfig;
  candles: Record<string, Candle[]>;
  tier: ReturnType<typeof resolveTier>["current"];
  dataAgeSeconds: number;
  halted: boolean;
};

export function scanCryptoTrend(ctx: CryptoTrendScanContext): ScoredOpportunity[] {
  const { config } = ctx;
  const portfolio = computePortfolio(config.navUsd, config.sleeves);
  const def = sleeveForStrategy("H1");
  const st = portfolio.sleeves.find((s) => s.def.id === def?.id);
  const sleeve: SleeveContext | undefined = st && {
    id: st.def.id,
    name: st.def.name,
    enabled: st.allocation.enabled,
    halted: st.allocation.halted,
    allocatedUsd: st.allocatedUsd,
    deployedUsd: st.deployedUsd,
    maxPositionUsd: st.maxPositionUsd,
    maxLeverage: st.def.limits.maxLeverage,
    maxConcurrentPositions: st.def.limits.maxConcurrentPositions,
    openPositions: 0,
    minimumViableUsd: st.minimumViableUsd,
  };

  const out: ScoredOpportunity[] = [];
  for (const [asset, series] of Object.entries(ctx.candles)) {
    const state = cryptoTrendState(series);
    if (!state) continue;

    const decision = evaluateTrendGate({
      tier: ctx.tier,
      sleeve,
      engaged: state.breakout,
      annualisedVol: state.annualisedVol,
      stopDistanceFraction: state.stopDistanceFraction,
      targetAnnualVol: config.targetAnnualVol,
      riskPerTradeFraction: H1_RISK_PER_TRADE,
      openPositions: 0,
      leverage: 1, // long-only spot
      maxLeverage: config.maxLeverage,
      venueMinNotionalUsd: 10,
      staleData: false,
      globalHalt: ctx.halted,
    });

    // Only report engaged breakouts and rejections worth seeing — a quiet
    // chart is silence, not a row.
    if (!state.breakout && decision.allowed) continue;
    if (!state.breakout && !sleeve?.enabled) continue;

    const sized = decision.allowed ? decision.sizedNotionalUsd : 0;
    out.push({
      id: `H1-${asset}`,
      ts: Date.now(),
      strategy: "H1",
      strategyName: "Crypto trend",
      asset,
      route: `Binance ${asset} breakout`,
      riskTier: "medium",
      sleeveId: sleeve?.id ?? "systematic",
      sleeveName: sleeve?.name ?? "Systematic",
      grossBps: 0,
      feesBps: 0,
      spreadBps: 0,
      slippageBps: 0,
      dragBps: 0,
      netBps: 0,
      netApr: null,
      breakevenDays: null,
      capitalRequiredUsd: sized,
      notionalUsd: sized,
      expectedProfitUsd: 0,
      trend: state.breakout
        ? {
            direction: "long",
            strengthPct: 0,
            annualisedVol: state.annualisedVol,
            stopDistanceFraction: state.stopDistanceFraction,
            stale: false,
          }
        : undefined,
      taken: false,
      wouldTake: decision.allowed && state.breakout,
      rejectionCode: decision.allowed ? null : decision.code,
      rejectionDetail: decision.allowed
        ? `${H1_ENTRY_N}d breakout · stop ${(state.stopDistanceFraction * 100).toFixed(1)}% below`
        : decision.detail,
    });
  }
  return out;
}
