/**
 * Funding-persistence model — the system's first machine learning.
 *
 * The question it answers is the one today's backtest proved decides carry
 * P&L: **given the recent funding regime, will funding stay worth holding
 * over the next week?** The live exit hysteresis already answers this with a
 * crude rule (trailing median > 0); this model is the same judgment made from
 * more of the evidence — level, persistence, stability, and momentum of the
 * regime together.
 *
 * Design constraints, in order:
 *
 *   1. **It never places orders** (DESIGN.md principle 7). The output is a
 *      probability attached to opportunities; gates stay hard-coded rules.
 *   2. **It must be honest before it is used.** Walk-forward validation on
 *      real history, always compared against the naive baseline it must beat
 *      (median > 0). If it cannot beat the baseline out-of-sample, the
 *      Research screen says so and the baseline stays in charge.
 *   3. **Deterministic and dependency-free.** Logistic regression via plain
 *      gradient descent: zero-initialised (the loss is convex, so no random
 *      restarts needed), standardised features, fixed iteration count. Same
 *      data in, same model out — testable to the same bar as the calc core.
 *
 * Why logistic regression and not something fancier: with ~8 assets and ~1000
 * funding intervals each, a few thousand overlapping samples is small data.
 * Five features and a linear model is what that sample size honestly
 * supports; a deeper model here would memorise noise and manufacture
 * confidence — the modelling equivalent of the optimistic backtester
 * DESIGN.md §9 warns about.
 */

export type FundingSample = {
  /** Funding rate for one interval, as a fraction (what a short receives). */
  rate: number;
  /** The same interval, annualised. */
  apr: number;
};

/** Trailing window the features are computed over, in funding intervals. */
export const FEATURE_WINDOW = 30;
/** Horizon the label looks ahead, in 8h intervals — 21 ≈ one week. */
export const LABEL_HORIZON = 21;

export const FEATURE_NAMES = [
  "medianApr",
  "positiveShare",
  "volatilityApr",
  "latestApr",
  "momentumApr",
] as const;

export type FeatureVector = number[];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Features of one trailing window, in FEATURE_NAMES order. */
export function extractFeatures(window: FundingSample[]): FeatureVector {
  const aprs = window.map((p) => p.apr);
  const n = aprs.length;
  const mean = aprs.reduce((a, b) => a + b, 0) / n;
  const variance =
    n < 2 ? 0 : aprs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);

  const tail = aprs.slice(-5);
  const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;

  return [
    median(aprs),
    aprs.filter((r) => r > 0).length / n,
    Math.sqrt(variance),
    aprs[n - 1],
    // Recent level vs the window's — is the regime strengthening or decaying?
    tailMean - mean,
  ];
}

export type Example = {
  x: FeatureVector;
  /** 1 when the NEXT `horizon` intervals of funding sum positive — i.e. the
   * carry would actually have earned over the hold. The economic label, not
   * a cosmetic one like "next print is positive". */
  y: 0 | 1;
  /** Index into the source series, for time-ordered splits. */
  i: number;
};

/**
 * Turn one asset's funding series into labelled examples.
 *
 * Overlapping windows are deliberate — funding series are short, and the
 * walk-forward split (never random shuffling) is what keeps the overlap from
 * leaking future information into training.
 */
export function buildDataset(
  series: FundingSample[],
  window = FEATURE_WINDOW,
  horizon = LABEL_HORIZON,
): Example[] {
  const out: Example[] = [];
  for (let i = window - 1; i + horizon < series.length; i++) {
    const x = extractFeatures(series.slice(i - window + 1, i + 1));
    let forward = 0;
    for (let j = i + 1; j <= i + horizon; j++) forward += series[j].rate;
    out.push({ x, y: forward > 0 ? 1 : 0, i });
  }
  return out;
}

/* ---------------------------------------------------------------- model */

export type LogisticModel = {
  weights: number[];
  bias: number;
  /** Standardisation constants, learned on the training set only. */
  means: number[];
  stds: number[];
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Train by full-batch gradient descent on standardised features.
 *
 * Fixed iterations and zero init keep it deterministic; small L2 keeps the
 * weights sane when a feature barely varies in a fold.
 */
export function trainLogistic(
  examples: Example[],
  opts: { iterations?: number; learningRate?: number; l2?: number } = {},
): LogisticModel {
  const iterations = opts.iterations ?? 400;
  const lr = opts.learningRate ?? 0.5;
  const l2 = opts.l2 ?? 1e-3;

  const d = FEATURE_NAMES.length;
  const n = examples.length;

  const means = new Array(d).fill(0);
  const stds = new Array(d).fill(1);
  for (let k = 0; k < d; k++) {
    let sum = 0;
    for (const e of examples) sum += e.x[k];
    means[k] = n > 0 ? sum / n : 0;
    let varSum = 0;
    for (const e of examples) varSum += (e.x[k] - means[k]) ** 2;
    const sd = n > 1 ? Math.sqrt(varSum / (n - 1)) : 0;
    stds[k] = sd > 1e-12 ? sd : 1;
  }

  const z = examples.map((e) => e.x.map((v, k) => (v - means[k]) / stds[k]));

  const weights = new Array(d).fill(0);
  let bias = 0;

  for (let it = 0; it < iterations; it++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let r = 0; r < n; r++) {
      let s = bias;
      for (let k = 0; k < d; k++) s += weights[k] * z[r][k];
      const err = sigmoid(s) - examples[r].y;
      for (let k = 0; k < d; k++) gradW[k] += err * z[r][k];
      gradB += err;
    }
    for (let k = 0; k < d; k++) {
      weights[k] -= lr * (gradW[k] / n + l2 * weights[k]);
    }
    bias -= lr * (gradB / n);
  }

  return { weights, bias, means, stds };
}

/** Probability that funding persists (label = 1) for one feature vector. */
export function predictProbability(model: LogisticModel, x: FeatureVector): number {
  let s = model.bias;
  for (let k = 0; k < model.weights.length; k++) {
    s += model.weights[k] * ((x[k] - model.means[k]) / model.stds[k]);
  }
  return sigmoid(s);
}

/** Convenience: probability straight from a trailing funding window. */
export function persistenceProbability(
  model: LogisticModel,
  window: FundingSample[],
): number | null {
  if (window.length < FEATURE_WINDOW) return null;
  return predictProbability(model, extractFeatures(window.slice(-FEATURE_WINDOW)));
}

/* ---------------------------------------------------------- walk-forward */

export type WalkForwardResult = {
  samples: number;
  testedSamples: number;
  folds: number;
  /** Share of the tested period where funding actually persisted. */
  baseRate: number;
  /** Model accuracy at the 0.5 threshold, out-of-sample. */
  accuracy: number;
  /** Naive baseline the model must beat: predict persist when median > 0. */
  baselineAccuracy: number;
  /** When the model says ≥70%, how often was it right? The gate-relevant number. */
  precisionAt70: number;
  /** How often the model says ≥70% — a precise model nobody can act on is useless. */
  coverageAt70: number;
  /** Same two numbers for the baseline's "yes" (median > 0). */
  baselinePrecision: number;
  baselineCoverage: number;
  /** Mean squared probability error — lower is better calibrated. */
  brier: number;
  /** The verdict the Research screen leads with. */
  beatsBaseline: boolean;
};

/**
 * Expanding-window walk-forward validation.
 *
 * Five chronological folds over the later half of the data: train on
 * everything before the fold, test on the fold, never the reverse. Random
 * splits would let overlapping windows leak the answer backwards in time and
 * flatter the model — the exact failure a validation exists to prevent.
 */
export function walkForward(
  examples: Example[],
  folds = 5,
): WalkForwardResult {
  const sorted = [...examples].sort((a, b) => a.i - b.i);
  const n = sorted.length;
  const start = Math.floor(n / 2);
  const foldSize = Math.max(1, Math.floor((n - start) / folds));

  let correct = 0;
  let baseCorrect = 0;
  let tested = 0;
  let positives = 0;
  let brierSum = 0;
  let confident = 0;
  let confidentRight = 0;
  let baseYes = 0;
  let baseYesRight = 0;

  for (let f = 0; f < folds; f++) {
    const lo = start + f * foldSize;
    const hi = f === folds - 1 ? n : Math.min(n, lo + foldSize);
    if (lo >= hi) break;

    const model = trainLogistic(sorted.slice(0, lo));

    for (let r = lo; r < hi; r++) {
      const e = sorted[r];
      const p = predictProbability(model, e.x);
      const medianApr = e.x[0];

      tested++;
      positives += e.y;
      brierSum += (p - e.y) ** 2;
      if ((p >= 0.5 ? 1 : 0) === e.y) correct++;
      if ((medianApr > 0 ? 1 : 0) === e.y) baseCorrect++;
      if (p >= 0.7) {
        confident++;
        if (e.y === 1) confidentRight++;
      }
      if (medianApr > 0) {
        baseYes++;
        if (e.y === 1) baseYesRight++;
      }
    }
  }

  const accuracy = tested > 0 ? correct / tested : 0;
  const baselineAccuracy = tested > 0 ? baseCorrect / tested : 0;
  const precisionAt70 = confident > 0 ? confidentRight / confident : 0;
  const baselinePrecision = baseYes > 0 ? baseYesRight / baseYes : 0;

  return {
    samples: n,
    testedSamples: tested,
    folds,
    baseRate: tested > 0 ? positives / tested : 0,
    accuracy,
    baselineAccuracy,
    precisionAt70,
    coverageAt70: tested > 0 ? confident / tested : 0,
    baselinePrecision,
    baselineCoverage: tested > 0 ? baseYes / tested : 0,
    brier: tested > 0 ? brierSum / tested : 0,
    // The bar: better precision when confident AND at least baseline accuracy.
    beatsBaseline:
      tested > 0 && precisionAt70 >= baselinePrecision && accuracy >= baselineAccuracy,
  };
}
