// Opportunity scoring — TS port of backend/oddsengine/scoring.py for the
// serverless scanner. Same weights (spec §14.7), same sub-scores, so scores
// written by the Vercel scanner rank consistently with the Python engine's.

export interface ScoringWeights {
  margin: number; executable_size: number; window_duration: number;
  venue_softness: number; rule_risk: number; account_safety: number;
  fx_risk: number; resolution_risk: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  margin: 0.3, executable_size: 0.15, window_duration: 0.15, venue_softness: 0.1,
  rule_risk: 0.1, account_safety: 0.1, fx_risk: 0.05, resolution_risk: 0.05,
};

export interface ScoreInput {
  marginPct: number;
  executableZarPerLeg: number;
  minExecutableZar: number;
  predictedWindowS: number;
  legSoftness: number[];
  stakesNatural: boolean;
  ruleRisk: boolean;
  hasPmLeg: boolean;
  isNegRisk: boolean;
  isInternal: boolean;
  isLive: boolean;
  mainstreamLeague: boolean;
}

export function scoreOpportunity(inp: ScoreInput, weights = DEFAULT_WEIGHTS) {
  const marginScore = Math.max(0, Math.min(inp.marginPct / 5, 1));
  const execScore = inp.executableZarPerLeg <= 0
    ? 0
    : Math.max(0, Math.min(inp.executableZarPerLeg / (4 * inp.minExecutableZar), 1));
  const windowScore = Math.max(0, Math.min(inp.predictedWindowS / 300, 1));
  const softness = inp.legSoftness.length
    ? inp.legSoftness.reduce((a, b) => a + b, 0) / inp.legSoftness.length
    : 0.5;
  const ruleScore = inp.ruleRisk ? 0.25 : 1;

  let safety = 1;
  if (!inp.mainstreamLeague) safety -= 0.25;
  if (!inp.stakesNatural) safety -= 0.2;
  if (inp.marginPct > 8) safety -= 0.3;
  if (inp.isLive) safety -= 0.2;
  safety = Math.max(0, safety);

  const fxScore = inp.hasPmLeg ? 0.7 : 1;
  let resolutionScore = 1;
  if (inp.hasPmLeg) {
    if (inp.isLive) resolutionScore = 0.3;
    else if (inp.isNegRisk) resolutionScore = 0.5;
    else if (inp.isInternal) resolutionScore = 0.85;
    else resolutionScore = 0.6;
  }

  const subs: Record<string, number> = {
    margin: marginScore, executable_size: execScore, window_duration: windowScore,
    venue_softness: softness, rule_risk: ruleScore, account_safety: safety,
    fx_risk: fxScore, resolution_risk: resolutionScore,
  };
  const total = 100 * Object.entries(weights).reduce(
    (acc, [k, w]) => acc + w * (subs[k] ?? 0), 0,
  );
  return { score: Math.round(total * 10) / 10, breakdown: { ...subs, staleness_factor: 1 } };
}
