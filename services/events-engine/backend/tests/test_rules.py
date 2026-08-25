"""Rules-compatibility matrix (spec §14.4): only same-group legs are clean arbs."""

from oddsengine.models import MarketType, Sport
from oddsengine.rules import (
    PER_MARKET,
    UNVERIFIED,
    VenueRulesProfile,
    compatible,
    legs_clean,
    rules_group,
)


def _profile(**kw) -> VenueRulesProfile:
    return VenueRulesProfile(venue_id="t", **kw)


def test_tennis_retirement_axis():
    a = _profile(tennis_retirement="BALL_SERVED")
    b = _profile(tennis_retirement="BALL_SERVED")
    c = _profile(tennis_retirement="MATCH_COMPLETED")
    ga = rules_group(a, Sport.TENNIS, MarketType.MONEYLINE_2WAY)
    gb = rules_group(b, Sport.TENNIS, MarketType.MONEYLINE_2WAY)
    gc = rules_group(c, Sport.TENNIS, MarketType.MONEYLINE_2WAY)
    assert compatible(ga, gb) == (True, None)
    ok, note = compatible(ga, gc)
    assert not ok and "differ" in note


def test_unverified_and_per_market_never_clean():
    ok, note = compatible(UNVERIFIED, UNVERIFIED)
    assert not ok and "unverified" in note
    ok, _ = compatible("BALL_SERVED", PER_MARKET)
    assert not ok
    ok, _ = legs_clean(["BALL_SERVED", "BALL_SERVED", UNVERIFIED])
    assert not ok


def test_default_axis_markets_are_compatible():
    a = _profile()
    g = rules_group(a, Sport.CRICKET, MarketType.TOTALS)  # no decisive axis registered
    assert g == "DEFAULT"
    assert legs_clean(["DEFAULT", "DEFAULT"]) == (True, None)


def test_basketball_overtime_axis():
    inc = _profile(basketball_ot="INCLUDED")
    reg = _profile(basketball_ot="REGULATION_ONLY")
    gi = rules_group(inc, Sport.BASKETBALL, MarketType.TOTALS)
    gr = rules_group(reg, Sport.BASKETBALL, MarketType.TOTALS)
    assert not compatible(gi, gr)[0]
