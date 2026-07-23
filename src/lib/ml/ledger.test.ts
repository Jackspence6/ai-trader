/**
 * Tests for the prediction ledger.
 *
 * The properties that matter: maturation grades only complete horizons, the
 * scoreboard promotes only on a real sample that beats the baseline, and
 * demotion is automatic when the live edge decays.
 */

import { describe, expect, it } from "vitest";
import { LABEL_HORIZON } from "./persistence";
import {
  MATURITY_MS,
  maturePredictions,
  PROMOTION_MIN_MATURED,
  scorePredictions,
  type PredictionRecord,
} from "./ledger";

const rec = (over: Partial<PredictionRecord> = {}): PredictionRecord => ({
  ts: 0,
  key: "Binance:BTC",
  probability: 0.9,
  baselineSaysPersist: true,
  executed: false,
  ...over,
});

describe("maturePredictions", () => {
  const NOW = MATURITY_MS + 1000;
  const rates = (n: number, v = 0.0001) => new Array(n).fill(v);

  it("grades an aged prediction against the full horizon of funding", () => {
    const { stillPending, matured } = maturePredictions(
      [rec()],
      () => rates(LABEL_HORIZON),
      NOW,
    );
    expect(stillPending).toHaveLength(0);
    expect(matured).toHaveLength(1);
    expect(matured[0].outcome).toBe(true);
  });

  it("labels a failed regime as a miss", () => {
    const { matured } = maturePredictions([rec()], () => rates(LABEL_HORIZON, -0.0001), NOW);
    expect(matured[0].outcome).toBe(false);
  });

  it("keeps young predictions pending", () => {
    const { stillPending, matured } = maturePredictions(
      [rec({ ts: NOW - 1000 })],
      () => rates(LABEL_HORIZON),
      NOW,
    );
    expect(matured).toHaveLength(0);
    expect(stillPending).toHaveLength(1);
  });

  it("refuses to grade an incomplete funding window", () => {
    const { stillPending, matured } = maturePredictions(
      [rec()],
      () => rates(LABEL_HORIZON - 1),
      NOW,
    );
    expect(matured).toHaveLength(0);
    expect(stillPending).toHaveLength(1);
  });
});

describe("scorePredictions", () => {
  const matured = (n: number, right: number, over: Partial<PredictionRecord> = {}) =>
    Array.from({ length: n }, (_, i) =>
      rec({ outcome: i < right, maturedAt: 1, ...over }),
    );

  it("stays SHADOW below the promotion sample size", () => {
    const s = scorePredictions(matured(PROMOTION_MIN_MATURED - 1, PROMOTION_MIN_MATURED - 1), 0, 1);
    expect(s.status).toBe("shadow");
  });

  it("promotes to CONFIRMING when the live record beats the baseline", () => {
    // 40 matured: model confident on all, right on 36; baseline said persist
    // on all, right on the same 36 → equal precision → promotion (>=).
    const s = scorePredictions(matured(40, 36), 5, 1);
    expect(s.matured).toBe(40);
    expect(s.precisionAt70).toBeCloseTo(0.9);
    expect(s.status).toBe("confirming");
  });

  it("demotes automatically when the model falls behind the baseline", () => {
    // Model confident on everything but right on 20/40; baseline only said
    // persist where it was right (perfect baseline) → model < baseline.
    const rows = [
      ...Array.from({ length: 20 }, () =>
        rec({ outcome: true, baselineSaysPersist: true, maturedAt: 1 }),
      ),
      ...Array.from({ length: 20 }, () =>
        rec({ outcome: false, baselineSaysPersist: false, maturedAt: 1 }),
      ),
    ];
    const s = scorePredictions(rows, 0, 1);
    expect(s.precisionAt70).toBeCloseTo(0.5);
    expect(s.baselinePrecision).toBeCloseTo(1);
    expect(s.status).toBe("shadow");
  });

  it("splits decision quality by what the engine did", () => {
    const rows = [
      ...matured(3, 3, { executed: true }),
      ...matured(7, 2, { executed: false }),
    ];
    const s = scorePredictions(rows, 0, 1);
    expect(s.takes).toEqual({ count: 3, persisted: 3 });
    expect(s.rejects).toEqual({ count: 7, persisted: 2 });
  });
});
