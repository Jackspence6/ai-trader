"""Opportunity scoring model 0–100 (spec §5) with config weights (§14.7).

Each sub-score is 0..1; the total is 100 * staleness_factor * sum(w_i * s_i).
The full breakdown is persisted on every opportunity for later ML (spec §13:
"log everything now to create the training data").

account_safety encodes §14.8: mainstream markets with round stakes and sane margins
look like normal punters; live/fingerprint-heavy/too-good-to-be-true opportunities
"cost" account life and score lower.
"""

from __future__ import annotations

from .config import ScoringWeights, WindowPriors
from .models import MarketType, Opportunity, OpportunityType, Sport, TimingClass

MAINSTREAM_LEAGUES = {
    # SA core + global mainstream (extend via config as coverage grows)
    "betway premiership", "psl", "premier league", "epl", "la liga", "serie a",
    "bundesliga", "ligue 1", "ucl", "champions league", "currie cup", "urc",
    "united rugby championship", "sa20", "nba", "nfl", "atp", "wta",
}


def _margin_score(margin_pct: float) -> float:
    # 5% margin saturates; sub-1% barely registers.
    return max(0.0, min(margin_pct / 5.0, 1.0))


def _executable_score(exec_per_leg_zar: float, min_executable_zar: float) -> float:
    if exec_per_leg_zar <= 0:
        return 0.0
    if exec_per_leg_zar == float("inf"):
        return 1.0
    # min_executable = 0.25; 4x min = 1.0
    return max(0.0, min(exec_per_leg_zar / (4.0 * min_executable_zar), 1.0))


def _window_score(timing: TimingClass, priors: WindowPriors, predicted_window_s: float | None) -> float:
    window = predicted_window_s
    if window is None:
        window = {"pre_match": priors.pre_match, "near_kickoff": priors.near_kickoff,
                  "live": priors.live}[timing.value]
    # 300s (comfortable manual placement) saturates.
    return max(0.0, min(window / 300.0, 1.0))


def _softness_score(leg_softness: list[float]) -> float:
    if not leg_softness:
        return 0.5
    return sum(leg_softness) / len(leg_softness)


def _rule_risk_score(rule_risk: bool) -> float:
    return 0.25 if rule_risk else 1.0


def _account_safety_score(opp: Opportunity, stakes_natural: bool) -> float:
    s = 1.0
    league = (opp.league or "").strip().lower()
    if league not in MAINSTREAM_LEAGUES:
        s -= 0.25                      # obscure markets fingerprint arbers
    if not stakes_natural:
        s -= 0.20                      # calculator-shaped stakes (§14.8)
    if opp.margin_pct > 8.0:
        s -= 0.30                      # too-good margins: palpable-error void risk + profiling
    if opp.timing == TimingClass.LIVE:
        s -= 0.20                      # betting seconds after a line move is a classic tell
    mt = opp.market_key.split("|", 1)[0]
    if mt == MarketType.PROP.value:
        s -= 0.15
    same_venue = len({leg.venue_id for leg in opp.legs}) == 1 and not opp.legs[0].is_pm
    if same_venue:
        s -= 0.40                      # single-book underround is usually a palp error
    return max(0.0, s)


def _fx_score(opp: Opportunity) -> float:
    if not any(leg.is_pm for leg in opp.legs):
        return 1.0
    return 0.7  # buffered live FX applied; residual USD exposure remains


def _resolution_score(opp: Opportunity) -> float:
    pm_legs = [leg for leg in opp.legs if leg.is_pm]
    if not pm_legs:
        return 1.0
    mt = opp.market_key.split("|", 1)[0]
    if opp.timing == TimingClass.LIVE:
        return 0.3
    if mt == MarketType.NEGRISK_MULTI.value:
        return 0.5   # UMA + multi-outcome resolution complexity
    if opp.opp_type == OpportunityType.POLYMARKET_INTERNAL:
        return 0.85  # both legs resolve under the same market text
    return 0.6       # PM-vs-bookie: per-market resolution text unverified by default


def staleness_factor(max_leg_age_s: float, venue_interval_s: float, max_age_factor: float) -> float:
    if max_leg_age_s <= venue_interval_s * 1.5:
        return 1.0
    if max_leg_age_s <= venue_interval_s * max_age_factor:
        return 0.6
    return 0.0  # engine should have excluded it already


def score_opportunity(
    opp: Opportunity,
    weights: ScoringWeights,
    priors: WindowPriors,
    *,
    min_executable_zar: float,
    leg_softness: list[float],
    stakes_natural: bool,
    predicted_window_s: float | None = None,
    staleness: float = 1.0,
) -> tuple[float, dict[str, float]]:
    subs = {
        "margin": _margin_score(opp.margin_pct),
        "executable_size": _executable_score(opp.executable_zar_per_leg, min_executable_zar),
        "window_duration": _window_score(opp.timing, priors, predicted_window_s),
        "venue_softness": _softness_score(leg_softness),
        "rule_risk": _rule_risk_score(opp.rule_risk),
        "account_safety": _account_safety_score(opp, stakes_natural),
        "fx_risk": _fx_score(opp),
        "resolution_risk": _resolution_score(opp),
    }
    w = weights.model_dump()
    total = 100.0 * staleness * sum(w[k] * v for k, v in subs.items())
    breakdown = {**subs, "staleness_factor": staleness}
    return round(total, 1), breakdown


def classify_timing(minutes_to_start: float | None, priors_window_min: float = 60.0) -> TimingClass:
    if minutes_to_start is None:
        return TimingClass.PRE_MATCH
    if minutes_to_start <= 0:
        return TimingClass.LIVE
    if minutes_to_start <= priors_window_min:
        return TimingClass.NEAR_KICKOFF
    return TimingClass.PRE_MATCH


def classify_urgency(timing: TimingClass, minutes_to_start: float | None) -> str:
    from .models import Urgency

    if timing == TimingClass.LIVE:
        return Urgency.CRITICAL
    if timing == TimingClass.NEAR_KICKOFF:
        return Urgency.HIGH
    if minutes_to_start is not None and minutes_to_start <= 6 * 60:
        return Urgency.MEDIUM
    return Urgency.LOW


def is_mainstream(sport: Sport, league: str | None) -> bool:
    return (league or "").strip().lower() in MAINSTREAM_LEAGUES
