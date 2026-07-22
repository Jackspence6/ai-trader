/**
 * Tests for the funding-persistence model.
 *
 * A model module earns trust the same way the calc core does: deterministic
 * outputs and hand-checkable behavior on synthetic series where the right
 * answer is known. The learnability test uses a series where persistence is
 * perfectly determined by the regime — if the model cannot learn THAT, the
 * plumbing is broken.
 */

import { describe, expect, it } from "vitest";
import {
  buildDataset,
  extractFeatures,
  FEATURE_WINDOW,
  LABEL_HORIZON,
  persistenceProbability,
  predictProbability,
  trainLogistic,
  walkForward,
  type FundingSample,
} from "./persistence";

/** A funding series alternating between clean regimes of `len` intervals. */
function regimeSeries(blocks: { apr: number; len: number }[]): FundingSample[] {
  const out: FundingSample[] = [];
  for (const b of blocks) {
    for (let i = 0; i < b.len; i++) {
      // 8h interval rate implied by the APR.
      out.push({ apr: b.apr, rate: b.apr / ((24 * 365) / 8) });
    }
  }
  return out;
}

describe("features and dataset", () => {
  it("computes hand-checkable features", () => {
    const win = regimeSeries([{ apr: 0.1, len: 30 }]);
    const [med, share, vol, latest, momentum] = extractFeatures(win);
    expect(med).toBeCloseTo(0.1);
    expect(share).toBe(1);
    expect(vol).toBeCloseTo(0);
    expect(latest).toBeCloseTo(0.1);
    expect(momentum).toBeCloseTo(0);
  });

  it("labels on the ECONOMIC outcome — forward funding sum", () => {
    // 60 positive intervals then deeply negative. The first example's window
    // uses intervals 0–29 and its horizon 30–50 — entirely positive → 1. The
    // last example's horizon sits inside the negative regime → 0.
    const series = regimeSeries([
      { apr: 0.2, len: 60 },
      { apr: -0.6, len: 40 },
    ]);
    const ds = buildDataset(series);
    expect(ds.length).toBe(series.length - FEATURE_WINDOW + 1 - LABEL_HORIZON);
    expect(ds[0].y).toBe(1); // horizon entirely inside the positive regime
    expect(ds[ds.length - 1].y).toBe(0); // horizon entirely inside the negative one
  });

  it("is deterministic — same data, same model, same prediction", () => {
    const series = regimeSeries([
      { apr: 0.15, len: 60 },
      { apr: -0.1, len: 60 },
      { apr: 0.12, len: 60 },
    ]);
    const ds = buildDataset(series);
    const a = trainLogistic(ds);
    const b = trainLogistic(ds);
    expect(a.weights).toEqual(b.weights);
    expect(predictProbability(a, ds[0].x)).toBe(predictProbability(b, ds[0].x));
  });
});

describe("learning", () => {
  // Alternating clean regimes: persistence is perfectly predictable from the
  // window (positive regime persists unless near the flip). A working learner
  // must separate the obvious cases with confidence.
  const series = regimeSeries([
    { apr: 0.2, len: 80 },
    { apr: -0.2, len: 80 },
    { apr: 0.2, len: 80 },
    { apr: -0.2, len: 80 },
  ]);
  const ds = buildDataset(series);
  const model = trainLogistic(ds);

  it("assigns high probability deep inside a positive regime", () => {
    const deepPositive = regimeSeries([{ apr: 0.2, len: FEATURE_WINDOW }]);
    expect(persistenceProbability(model, deepPositive)!).toBeGreaterThan(0.6);
  });

  it("assigns low probability deep inside a negative regime", () => {
    const deepNegative = regimeSeries([{ apr: -0.2, len: FEATURE_WINDOW }]);
    expect(persistenceProbability(model, deepNegative)!).toBeLessThan(0.4);
  });

  it("refuses to predict from an underfull window", () => {
    const short = regimeSeries([{ apr: 0.2, len: FEATURE_WINDOW - 1 }]);
    expect(persistenceProbability(model, short)).toBeNull();
  });
});

describe("walk-forward validation", () => {
  it("splits chronologically and reports honest out-of-sample metrics", () => {
    const series = regimeSeries([
      { apr: 0.2, len: 70 },
      { apr: -0.2, len: 70 },
      { apr: 0.2, len: 70 },
      { apr: -0.2, len: 70 },
    ]);
    const wf = walkForward(buildDataset(series));
    expect(wf.testedSamples).toBeGreaterThan(50);
    // On perfectly regime-determined data the model must do well OOS.
    expect(wf.accuracy).toBeGreaterThan(0.6);
    expect(wf.brier).toBeLessThan(0.3);
    // Coverage sanity: probabilities are used, not just rankings.
    expect(wf.coverageAt70).toBeGreaterThan(0);
    expect(wf.coverageAt70).toBeLessThan(1);
  });

  it("cannot beat the baseline on coin-flip data — and says so", () => {
    // Deterministic pseudo-noise (no Math.random): a fixed irrational-stride
    // sequence with no regime structure. The honest verdict is "no edge".
    const series: FundingSample[] = [];
    for (let i = 0; i < 400; i++) {
      const v = Math.sin(i * 12.9898) * 43758.5453;
      const apr = (v - Math.floor(v) - 0.5) * 0.4;
      series.push({ apr, rate: apr / ((24 * 365) / 8) });
    }
    const wf = walkForward(buildDataset(series));
    // No structure → accuracy should hover near the base rate, far from 90%.
    expect(wf.accuracy).toBeLessThan(0.75);
  });
});
