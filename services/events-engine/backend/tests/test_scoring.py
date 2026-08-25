"""Scoring model: weights, breakdown persistence, §14.8 account-safety behavior."""

from oddsengine.config import ScoringWeights, WindowPriors
from oddsengine.models import Leg, Opportunity, OpportunityType, Sport, TimingClass, Urgency
from oddsengine.scoring import score_opportunity, staleness_factor


def make_opp(**overrides) -> Opportunity:
    legs = overrides.pop("legs", [
        Leg(venue_id="a", venue_name="A", outcome="HOME", selection_label="X", odds=2.4,
            order_index=1),
        Leg(venue_id="b", venue_name="B", outcome="AWAY", selection_label="Y", odds=2.1,
            order_index=2),
    ])
    base = dict(
        id="x1", opp_type=OpportunityType.BOOKIE_BOOKIE, event_id="e", event_label="X vs Y",
        sport=Sport.SOCCER, league="Betway Premiership", market_key="1X2|", legs=legs,
        margin_pct=3.0, executable_zar_per_leg=8000.0, urgency=Urgency.LOW,
        timing=TimingClass.PRE_MATCH,
    )
    base.update(overrides)
    return Opportunity(**base)


W, P = ScoringWeights(), WindowPriors()


def _score(opp, **kw):
    defaults = dict(min_executable_zar=2000, leg_softness=[0.7, 0.6], stakes_natural=True)
    defaults.update(kw)
    return score_opportunity(opp, W, P, **defaults)


def test_score_range_and_breakdown_persisted():
    score, breakdown = _score(make_opp())
    assert 0 <= score <= 100
    for key in ("margin", "executable_size", "window_duration", "venue_softness",
                "rule_risk", "account_safety", "fx_risk", "resolution_risk", "staleness_factor"):
        assert key in breakdown


def test_rule_risk_and_live_timing_penalized():
    clean, _ = _score(make_opp())
    ruled, _ = _score(make_opp(rule_risk=True))
    assert ruled < clean
    live, bd = _score(make_opp(timing=TimingClass.LIVE, urgency=Urgency.CRITICAL))
    assert live < clean
    assert bd["account_safety"] < 1.0  # betting right after a move is a profiling tell (§14.8)


def test_account_safety_dimensions():
    _, mainstream = _score(make_opp())
    _, obscure = _score(make_opp(league="Belarus Reserve League"))
    assert obscure["account_safety"] < mainstream["account_safety"]
    _, calculator = _score(make_opp(), stakes_natural=False)
    assert calculator["account_safety"] < mainstream["account_safety"]
    _, toogood = _score(make_opp(margin_pct=12.0))
    assert toogood["account_safety"] < mainstream["account_safety"]
    same_legs = [
        Leg(venue_id="a", venue_name="A", outcome="HOME", selection_label="X", odds=2.4, order_index=1),
        Leg(venue_id="a", venue_name="A", outcome="AWAY", selection_label="Y", odds=2.2, order_index=2),
    ]
    _, palp = _score(make_opp(legs=same_legs))
    assert palp["account_safety"] <= mainstream["account_safety"] - 0.3


def test_fx_and_resolution_only_hit_pm_opportunities():
    _, no_pm = _score(make_opp())
    pm_legs = [
        Leg(venue_id="bk", venue_name="Bk", outcome="AWAY", selection_label="Y", odds=2.1, order_index=1),
        Leg(venue_id="polymarket", venue_name="Polymarket", outcome="HOME", selection_label="Yes",
            odds=1.951, is_pm=True, order_index=2),
    ]
    _, with_pm = _score(make_opp(legs=pm_legs, opp_type=OpportunityType.BOOKIE_POLYMARKET))
    assert no_pm["fx_risk"] == 1.0 and with_pm["fx_risk"] < 1.0
    assert no_pm["resolution_risk"] == 1.0 and with_pm["resolution_risk"] < 1.0


def test_staleness_factor_bands():
    assert staleness_factor(5, 20, 2.5) == 1.0
    assert staleness_factor(40, 20, 2.5) == 0.6
    assert staleness_factor(200, 20, 2.5) == 0.0
