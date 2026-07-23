/**
 * The prediction ledger — how the model learns from its own record.
 *
 * The walk-forward validation proved the persistence model on *history*. This
 * module holds it to the harder standard: every prediction it makes LIVE is
 * written down at the moment it is made, matured against what funding then
 * actually did, and scored against the naive baseline — permanently, in the
 * same append-only style as every other record here.
 *
 * That ledger is what makes self-improvement honest instead of vibes:
 *
 *   - **It cannot forget its mistakes.** A rejected opportunity that would
 *     have earned, or a confident prediction that failed, is a matured row
 *     forever, not a memory that fades.
 *   - **Autonomy is earned, not granted.** The model starts in SHADOW. Only
 *     when its matured live record beats the baseline over a real sample does
 *     it get promoted to CONFIRMING — and even then it only vetoes weak L1
 *     entries; it never generates a trade (DESIGN.md principle 7). If its
 *     live edge decays, it is demoted the same way, automatically.
 *   - **Decision quality is measured, not assumed.** Matured rows split by
 *     what the engine did (took vs rejected) show the two error rates that
 *     matter: bad takes, and regretted rejections.
 */

import { appendLog, readJson, readLog, writeJson } from "@/lib/store/kv";
import { LABEL_HORIZON } from "./persistence";

/** Matured predictions: labelled, immutable, append-only forever. */
export const ML_MATURED_LOG = "ml_matured";
/** Predictions awaiting their horizon: a small mutable working set. */
export const ML_PENDING_KEY = "ml_pending";
export const ML_SCOREBOARD_KEY = "ml_scoreboard";

/** One prediction, recorded at decision time and labelled at maturity. */
export type PredictionRecord = {
  ts: number;
  /** `${venue}:${asset}` the prediction was made for. */
  key: string;
  /** Model probability that funding persists over the horizon. */
  probability: number;
  /** What the naive baseline said at the same instant (median > 0). */
  baselineSaysPersist: boolean;
  /** Whether the engine actually entered an L1 trade on this asset this pass. */
  executed: boolean;
  /** Filled at maturity: did funding actually sum positive over the horizon? */
  outcome?: boolean;
  maturedAt?: number;
};

/** The 7-day label horizon, in wall-clock ms (21 × 8h funding intervals). */
export const MATURITY_MS = LABEL_HORIZON * 8 * 3600_000;

export type Scoreboard = {
  pending: number;
  matured: number;
  /** Of matured predictions ≥70% confident, how often funding persisted. */
  precisionAt70: number | null;
  confidentCount: number;
  /** Baseline (median>0) precision on the same matured rows. */
  baselinePrecision: number | null;
  baselineCount: number;
  /** Decision quality: outcome rates split by what the engine did. */
  takes: { count: number; persisted: number };
  rejects: { count: number; persisted: number };
  /** The verdict the promotion gate reads. */
  status: "shadow" | "confirming";
  updatedAt: number;
};

/** Matured sample the model must beat the baseline over before promotion. */
export const PROMOTION_MIN_MATURED = 40;

/**
 * Score matured rows and decide the model's standing.
 *
 * Promotion requires a real sample AND live precision at or above the
 * baseline's. Demotion is the same test failing — automatic, no ceremony —
 * because a model trading on last month's competence is exactly the failure
 * the ledger exists to catch.
 */
export function scorePredictions(
  maturedRows: PredictionRecord[],
  pendingCount: number,
  now: number,
): Scoreboard {
  const matured = maturedRows.filter((r) => r.outcome !== undefined);
  const pending = pendingCount;

  const confident = matured.filter((r) => r.probability >= 0.7);
  const confidentRight = confident.filter((r) => r.outcome).length;
  const baseYes = matured.filter((r) => r.baselineSaysPersist);
  const baseRight = baseYes.filter((r) => r.outcome).length;

  const takes = matured.filter((r) => r.executed);
  const rejects = matured.filter((r) => !r.executed);

  const precisionAt70 = confident.length > 0 ? confidentRight / confident.length : null;
  const baselinePrecision = baseYes.length > 0 ? baseRight / baseYes.length : null;

  const status: Scoreboard["status"] =
    matured.length >= PROMOTION_MIN_MATURED &&
    precisionAt70 !== null &&
    baselinePrecision !== null &&
    precisionAt70 >= baselinePrecision
      ? "confirming"
      : "shadow";

  return {
    pending,
    matured: matured.length,
    precisionAt70,
    confidentCount: confident.length,
    baselinePrecision,
    baselineCount: baseYes.length,
    takes: { count: takes.length, persisted: takes.filter((r) => r.outcome).length },
    rejects: { count: rejects.length, persisted: rejects.filter((r) => r.outcome).length },
    status,
    updatedAt: now,
  };
}

/**
 * Label every pending prediction old enough to judge.
 *
 * `fundingSince(key, ts)` returns the per-interval funding rates recorded
 * AFTER the prediction — the pass already holds this history in memory, so
 * maturation costs no extra fetch. A prediction only matures when the full
 * horizon of intervals exists; a partial window stays pending rather than
 * being graded early on a lucky prefix.
 */
export function maturePredictions(
  pending: PredictionRecord[],
  fundingSince: (key: string, ts: number) => number[] | undefined,
  now: number,
): { stillPending: PredictionRecord[]; matured: PredictionRecord[] } {
  const stillPending: PredictionRecord[] = [];
  const matured: PredictionRecord[] = [];
  for (const r of pending) {
    if (now - r.ts < MATURITY_MS) {
      stillPending.push(r);
      continue;
    }
    const rates = fundingSince(r.key, r.ts);
    if (!rates || rates.length < LABEL_HORIZON) {
      // Old enough but the funding window is incomplete (data gap): keep
      // waiting rather than grading on a lucky prefix.
      stillPending.push(r);
      continue;
    }
    const sum = rates.slice(0, LABEL_HORIZON).reduce((a, x) => a + x, 0);
    matured.push({ ...r, outcome: sum > 0, maturedAt: now });
  }
  return { stillPending, matured };
}

/* ------------------------------------------------------- durable plumbing */

export const readPending = async (): Promise<PredictionRecord[]> =>
  (await readJson<PredictionRecord[]>(ML_PENDING_KEY)) ?? [];
export const writePending = (rows: PredictionRecord[]) => writeJson(ML_PENDING_KEY, rows);
export const readMatured = () => readLog<PredictionRecord>(ML_MATURED_LOG);
export const appendMatured = (rows: PredictionRecord[]) => appendLog(ML_MATURED_LOG, rows);
export const readScoreboard = () => readJson<Scoreboard>(ML_SCOREBOARD_KEY);
export const writeScoreboard = (s: Scoreboard) => writeJson(ML_SCOREBOARD_KEY, s);
