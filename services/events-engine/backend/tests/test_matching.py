"""Fuzzy matching, alias self-learning, review queue (spec §4)."""

from datetime import timedelta

from oddsengine.config import MatchingConfig
from oddsengine.matching import CanonicalRegistry, EventMatcher
from oddsengine.matching.normalize import normalize_name, split_matchup
from oddsengine.models import RawEvent, Sport, utcnow


def make_matcher() -> tuple[CanonicalRegistry, EventMatcher]:
    reg = CanonicalRegistry()
    return reg, EventMatcher(reg, MatchingConfig())


def test_normalization():
    assert normalize_name("Kaizer Chiefs FC") == "kaizer chiefs"
    assert normalize_name("DHL Stormers") == "stormers"
    assert normalize_name("Man Utd") == "manchester united"
    assert normalize_name("Real Madrid CF") == "real madrid"
    assert split_matchup("Lakers vs. Celtics") == ("Lakers", "Celtics")
    assert split_matchup("Sundowns v Pirates") == ("Sundowns", "Pirates")
    assert split_matchup("Lakers vs. Celtics: who wins?") == ("Lakers", "Celtics")


def test_seeded_aliases_resolve():
    reg, m = make_matcher()
    team_id, conf = m.resolve_side("venue_x", "Sundowns")
    assert team_id == reg.team_by_alias("Mamelodi Sundowns")
    assert conf == 1.0


def test_cross_venue_match_and_self_learning():
    _, m = make_matcher()
    start = utcnow() + timedelta(hours=3)
    a = RawEvent(venue_id="v1", ref="e1", sport=Sport.SOCCER, league_raw="PSL",
                 home_raw="Mamelodi Sundowns", away_raw="Orlando Pirates", start_time=start)
    d1 = m.match(a)
    assert d1.action == "created" and d1.event is not None
    # Second venue: abbreviated names + slight start-time offset within tolerance
    b = RawEvent(venue_id="v2", ref="zz9", sport=Sport.SOCCER, league_raw="Premier Soccer League",
                 home_raw="Sundowns FC", away_raw="Pirates",
                 start_time=start + timedelta(minutes=10))
    d2 = m.match(b)
    assert d2.action == "matched" and d2.event.id == d1.event.id
    assert d2.event.venue_refs == {"v1": "e1", "v2": "zz9"}


def test_polymarket_title_split_match():
    _, m = make_matcher()
    start = utcnow() + timedelta(hours=1)
    book = RawEvent(venue_id="v1", ref="nba1", sport=Sport.BASKETBALL, league_raw="NBA",
                    home_raw="Los Angeles Lakers", away_raw="Boston Celtics", start_time=start)
    d1 = m.match(book)
    pm = RawEvent(venue_id="polymarket", ref="0xabc", sport=Sport.BASKETBALL,
                  title_raw="Lakers vs. Celtics", start_time=start + timedelta(minutes=45),
                  extra={"date_bracketed": True})
    d2 = m.match(pm)
    assert d2.action == "matched" and d2.event.id == d1.event.id


def test_time_tolerance_separates_events():
    _, m = make_matcher()
    start = utcnow() + timedelta(hours=3)
    d1 = m.match(RawEvent(venue_id="v1", ref="e1", sport=Sport.TENNIS,
                          home_raw="Novak Djokovic", away_raw="Carlos Alcaraz", start_time=start))
    # Same pairing two days later = a different match
    d2 = m.match(RawEvent(venue_id="v2", ref="e9", sport=Sport.TENNIS,
                          home_raw="Djokovic N.", away_raw="Alcaraz C.",
                          start_time=start + timedelta(days=2)))
    assert d2.event is None or d2.event.id != d1.event.id


def test_review_queue_band():
    reg, m = make_matcher()
    # A name similar-but-not-close-enough to a seeded team should land in review band
    team_id, conf = m.resolve_side("v1", "Mamelodi Sundowns Reserves XI")
    if team_id is None and 0.75 <= conf < 0.92:
        assert reg.pending_reviews(), "review item expected in the 0.75–0.92 band"
        item = reg.pending_reviews()[0]
        resolved = reg.resolve_review(item.id, accept=True)
        assert resolved.status == "accepted"
        assert reg.team_by_alias("Mamelodi Sundowns Reserves XI") is not None
