/**
 * Technical indicators — pure functions over price series.
 *
 * Every function here is deterministic and side-effect free so the same code
 * runs in the dashboard, the backtester, and (ported) the live engine. That is
 * DESIGN.md principle 1: one strategy codebase across backtest, paper and live.
 *
 * Convention: series are ordered oldest → newest. Functions return an array of
 * the same length as the input, with `null` for the warm-up period where the
 * indicator is not yet defined. Returning `null` rather than 0 or a truncated
 * array matters — a silently-shortened array misaligns every downstream index
 * and is one of the classic sources of lookahead bias in a backtest.
 */

/** Arithmetic mean. Returns null for an empty slice. */
export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Sample standard deviation (n−1 denominator).
 *
 * We use the sample form, not the population form, because every series we
 * measure is a sample of an ongoing process rather than a complete population.
 * At the window sizes we use (20–100) the difference is small but it biases
 * volatility low, and volatility feeds position sizing — so it is the direction
 * of error we least want.
 */
export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

/** Simple moving average. */
export function sma(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  if (n <= 0) return out;
  let run = 0;
  for (let i = 0; i < xs.length; i++) {
    run += xs[i];
    if (i >= n) run -= xs[i - n];
    if (i >= n - 1) out[i] = run / n;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `n` points.
 *
 * Seeding with an SMA rather than the first value alone is deliberate: seeding
 * on a single point lets one outlier dominate the early series, and in a
 * backtest that distortion sits exactly where the equity curve starts.
 */
export function ema(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  if (n <= 0 || xs.length < n) return out;
  const k = 2 / (n + 1);
  let prev = mean(xs.slice(0, n))!;
  out[n - 1] = prev;
  for (let i = n; i < xs.length; i++) {
    prev = xs[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Rolling z-score: how many standard deviations the current value sits from its
 * own recent mean.
 *
 * This is the single most reused primitive in the system. Funding rates, spot
 * spreads, stablecoin pegs and pairs residuals are all "is this unusually far
 * from normal?" questions, and a z-score answers them in units that are
 * comparable across assets with completely different price scales. A raw
 * funding rate of 0.01% means nothing on its own; +2.4σ against its own 30-day
 * history is a signal.
 */
export function zscore(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  for (let i = n - 1; i < xs.length; i++) {
    const w = xs.slice(i - n + 1, i + 1);
    const m = mean(w)!;
    const sd = stdev(w);
    // A flat window has zero dispersion; z is undefined, not infinite.
    if (sd === null || sd === 0) continue;
    out[i] = (xs[i] - m) / sd;
  }
  return out;
}

/**
 * Wilder's RSI.
 *
 * Used as a *filter*, never as a standalone entry. Classic "RSI < 30 = buy"
 * fails badly in crypto because strong trends park RSI at an extreme for days.
 * Its honest use here is to veto mean-reversion entries when momentum is still
 * accelerating against them.
 */
export function rsi(closes: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing — equivalent to an EMA with alpha = 1/n.
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * True range — the larger of the current bar's range and its gaps from the
 * previous close. Captures overnight/session gaps that high−low alone misses.
 */
export function trueRange(
  highs: number[],
  lows: number[],
  closes: number[],
): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    out[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  return out;
}

/**
 * Average True Range (Wilder-smoothed).
 *
 * ATR is the backbone of position sizing and stop placement. Sizing by ATR
 * rather than by a fixed percentage means every position risks the same amount
 * of *money* regardless of how volatile the asset is — so a SOL position and a
 * BTC position contribute comparable risk instead of SOL quietly dominating the
 * book.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  n = 14,
): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  const tr = trueRange(highs, lows, closes);
  if (closes.length <= n) return out;

  let acc = 0;
  for (let i = 1; i <= n; i++) acc += tr[i] ?? 0;
  let prev = acc / n;
  out[n] = prev;

  for (let i = n + 1; i < closes.length; i++) {
    prev = (prev * (n - 1) + (tr[i] ?? 0)) / n;
    out[i] = prev;
  }
  return out;
}

/**
 * Donchian channel — rolling highest high and lowest low over `n` bars,
 * **excluding the current bar**.
 *
 * The exclusion is the whole point and is easy to get wrong: if the current bar
 * is included, price can never exceed its own channel high, so a breakout can
 * never trigger. Backtests that include the current bar look conservative and
 * are actually broken.
 */
export function donchian(
  highs: number[],
  lows: number[],
  n: number,
): { upper: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(highs.length).fill(null);
  const lower: (number | null)[] = new Array(lows.length).fill(null);
  for (let i = n; i < highs.length; i++) {
    upper[i] = Math.max(...highs.slice(i - n, i));
    lower[i] = Math.min(...lows.slice(i - n, i));
  }
  return { upper, lower };
}

/** Simple period-over-period returns. Index 0 is null (no prior point). */
export function returns(xs: number[]): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  for (let i = 1; i < xs.length; i++) {
    out[i] = xs[i - 1] === 0 ? null : xs[i] / xs[i - 1] - 1;
  }
  return out;
}

/** Log returns — additive across time, which is what volatility scaling needs. */
export function logReturns(xs: number[]): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  for (let i = 1; i < xs.length; i++) {
    if (xs[i - 1] <= 0 || xs[i] <= 0) continue;
    out[i] = Math.log(xs[i] / xs[i - 1]);
  }
  return out;
}

/**
 * Annualised realised volatility from a close series.
 *
 * `periodsPerYear` is 365 for daily crypto bars (crypto does not close on
 * weekends — using 252 like equities understates crypto vol by ~17% and would
 * systematically oversize every position).
 */
export function realisedVol(
  closes: number[],
  periodsPerYear = 365,
  window = 30,
): number | null {
  const lr = logReturns(closes).filter((x): x is number => x !== null);
  if (lr.length < 2) return null;
  const w = lr.slice(-window);
  const sd = stdev(w);
  if (sd === null) return null;
  return sd * Math.sqrt(periodsPerYear);
}

/** Peak-to-trough decline of an equity curve, as a negative fraction. */
export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = v / peak - 1;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Annualised Sharpe ratio.
 *
 * Reported with a deliberate caveat everywhere it surfaces in the UI: Sharpe on
 * a short sample of a market-neutral carry strategy is flattering and unstable.
 * Carry earns a small amount very consistently right up until it doesn't, which
 * is precisely the return shape Sharpe overstates. It is a diagnostic here, not
 * a target to optimise.
 */
export function sharpe(
  periodReturns: number[],
  periodsPerYear = 365,
  riskFreeAnnual = 0,
): number | null {
  if (periodReturns.length < 2) return null;
  const rfPer = riskFreeAnnual / periodsPerYear;
  const excess = periodReturns.map((r) => r - rfPer);
  const m = mean(excess)!;
  const sd = stdev(excess);
  if (sd === null || sd === 0) return null;
  return (m / sd) * Math.sqrt(periodsPerYear);
}

/**
 * Sortino ratio — like Sharpe but penalising only downside deviation.
 *
 * More honest than Sharpe for carry strategies, whose upside "volatility" is
 * just the funding payments arriving.
 */
export function sortino(
  periodReturns: number[],
  periodsPerYear = 365,
  target = 0,
): number | null {
  if (periodReturns.length < 2) return null;
  const m = mean(periodReturns.map((r) => r - target))!;
  const downside = periodReturns.filter((r) => r < target).map((r) => (r - target) ** 2);
  if (downside.length === 0) return null;
  const dd = Math.sqrt(downside.reduce((a, b) => a + b, 0) / periodReturns.length);
  if (dd === 0) return null;
  return (m / dd) * Math.sqrt(periodsPerYear);
}

/** Pearson correlation. Used to check that "diversified" positions actually are. */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x)!;
  const my = mean(y)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Percentile rank of `v` within `xs`, in [0, 1].
 *
 * Preferred over a z-score when a distribution is visibly non-normal — funding
 * rates have fat tails and a hard floor, so "this is the 97th percentile of the
 * last 90 days" is a more truthful statement than "+2.1σ".
 */
export function percentileRank(xs: number[], v: number): number | null {
  if (xs.length === 0) return null;
  let below = 0;
  for (const x of xs) if (x < v) below++;
  return below / xs.length;
}

/** Last non-null value of an indicator series — the "current reading". */
export function latest<T>(xs: (T | null)[]): T | null {
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i] !== null) return xs[i] as T;
  }
  return null;
}
