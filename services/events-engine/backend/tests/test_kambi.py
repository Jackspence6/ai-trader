"""Kambi/Sunbet adapter tests.

The fixture is a trimmed live capture from Sunbet's Kambi offering (2026-08-25),
kept adversarial on purpose: half of the bet offers are markets that look like the
match markets but settle differently. Most of what this file asserts is what the
adapter must REFUSE, because a false positive here is a phantom arb with real money
behind it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from oddsengine.models import MarketStatus, MarketType, Sport
from oddsengine.rules import UNVERIFIED
from oddsengine.venues.kambi import (
    KAMBI_ALLOWLIST,
    classify_bet_offer,
    milli_line,
    milli_odds,
)
from oddsengine.venues.sunbet import SunbetAdapter

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "kambi_psl_betoffers.json").read_text())
EVENT_REF = "1028561551"

ENDPOINTS = {
    "kambi_base": "https://eu.offering-api.kambicdn.com",
    "kambi_operator": "siwc",
    "kambi_params": "channel_id=1&client_id=200&lang=en_ZA&market=ZA",
}


@pytest.fixture
def adapter() -> SunbetAdapter:
    return SunbetAdapter(endpoints=dict(ENDPOINTS), enabled=True)


def offer(label: str) -> dict:
    for bo in FIXTURE["betOffers"]:
        if bo["criterion"]["englishLabel"] == label:
            return bo
    raise KeyError(label)


# --------------------------------------------------------------- wire formats

def test_milli_odds_are_divided_not_sniffed():
    # 1960 -> 1.96 matched the price rendered on sunbet.co.za at capture time.
    assert milli_odds(1960) == pytest.approx(1.96)
    assert milli_odds(3300) == pytest.approx(3.30)
    assert milli_odds(1010) == pytest.approx(1.01)   # a heuristic "> 1000" test would break here
    assert milli_odds(None) is None
    assert milli_odds(900) is None                   # implies 0.9 — not payable odds


def test_milli_lines_keep_their_sign():
    assert milli_line(2500) == pytest.approx(2.5)
    assert milli_line(-500) == pytest.approx(-0.5)


# ------------------------------------------------------------ url construction

def test_urls_are_built_from_operator_and_base(adapter):
    events_url = adapter.endpoints["events_url"]
    odds_url = adapter.endpoints["odds_url"]
    assert events_url.startswith(
        "https://eu.offering-api.kambicdn.com/offering/v2018/siwc/listView/{sport}.json")
    assert "client_id=200" in events_url and "market=ZA" in events_url
    assert "/betoffer/event/{event_ref}.json" in odds_url


def test_explicit_urls_are_not_overwritten():
    a = SunbetAdapter(endpoints={**ENDPOINTS, "events_url": "https://example.test/{sport}"},
                      enabled=True)
    assert a.endpoints["events_url"] == "https://example.test/{sport}"


def test_deep_link_points_at_the_public_event_page(adapter):
    assert adapter.deep_link(EVENT_REF) == (
        "https://www.sunbet.co.za/en/sports#/event/1028561551")


# ------------------------------------------------------------------- events

def test_parse_events_reads_the_listview_envelope(adapter):
    events = adapter.parse_events(FIXTURE)
    assert len(events) == 1
    ev = events[0]
    assert ev.ref == EVENT_REF
    assert ev.sport is Sport.SOCCER          # Kambi says "FOOTBALL"
    assert ev.home_raw == "Siwelele F.C."
    assert ev.away_raw == "Chippa United"
    assert ev.league_raw == "PSL"
    assert ev.start_time is not None and ev.start_time.tzinfo is not None
    assert ev.extra["path"] == ["football", "south_africa", "psl"]


# ------------------------------------------------- the allowlist: what maps

def test_full_time_maps_to_1x2(adapter):
    rule = classify_bet_offer(offer("Full Time"), Sport.SOCCER)
    assert rule is not None and rule.market_type is MarketType.X12
    assert rule.rules_axis == ("soccer_duration", "REG_90")


def test_total_goals_maps_with_its_line(adapter):
    markets = {m.ref: m for m in adapter.parse_markets(FIXTURE, EVENT_REF)}
    m = markets["2683078600"]
    assert m.market_type is MarketType.TOTALS
    assert m.line == pytest.approx(1.5)
    assert markets["2683078601"].line == pytest.approx(3.5)


def test_handicap_line_is_the_home_side(adapter):
    markets = {m.ref: m for m in adapter.parse_markets(FIXTURE, EVENT_REF)}
    m = markets["2683078700"]
    assert m.market_type is MarketType.HANDICAP
    assert m.line == pytest.approx(-0.5)      # OT_ONE side, not the mirrored +0.5


def test_full_match_btts_maps_despite_null_lifetime(adapter):
    """A blanket 'require lifetime == FULL_TIME' rule would silently drop this."""
    rule = classify_bet_offer(offer("Both Teams To Score"), Sport.SOCCER)
    assert rule is not None and rule.market_type is MarketType.BTTS


# ---------------------------------------------- the allowlist: what it refuses

@pytest.mark.parametrize("label", [
    "Total Corners",                  # betOfferType 6 + FULL_TIME, but corners
    "Total Goals by Chippa United",   # team total, contains "Total Goals"
    "Total Goals - 1st Half",         # half market
    "Draw No Bet - 2nd Half",         # betOfferType 2 like Full Time
    "Both Teams To Score - 1st Half", # same type and null lifetime as real BTTS
])
def test_lookalike_markets_are_refused(label):
    assert classify_bet_offer(offer(label), Sport.SOCCER) is None


def test_refused_markets_are_kept_but_unpriced(adapter):
    """Unmapped offers stay visible as raw markets; they just never get a quote."""
    markets = {m.ref: m for m in adapter.parse_markets(FIXTURE, EVENT_REF)}
    corners = markets["2683078901"]
    assert corners.market_type is None
    assert corners.market_type_raw == "Total Corners"
    assert corners.extra["mapped"] is False

    priced_refs = {u.market_ref for u in adapter.parse_odds(FIXTURE, EVENT_REF)}
    assert "2683078901" not in priced_refs


def test_a_market_is_refused_when_its_outcome_shape_changes(adapter):
    """Same label and lifetime, but a shape the allowlist never recorded."""
    mutated = json.loads(json.dumps(offer("Full Time")))
    mutated["outcomes"] = mutated["outcomes"][:2]       # 1X2 arriving as two outcomes
    assert classify_bet_offer(mutated, Sport.SOCCER) is None


def test_a_market_is_refused_for_the_wrong_sport(adapter):
    """Rugby 'Handicap' is not soccer 'Handicap' — the keys are sport-scoped."""
    assert classify_bet_offer(offer("Handicap"), Sport.RUGBY) is None


# ------------------------------------------------------------------- odds

def test_parse_odds_converts_and_labels(adapter):
    by_ref = {u.selection_ref: u for u in adapter.parse_odds(FIXTURE, EVENT_REF)}
    assert by_ref["4306997877"].decimal_odds == pytest.approx(1.96)
    assert by_ref["4306997878"].decimal_odds == pytest.approx(3.30)
    assert by_ref["4306997879"].decimal_odds == pytest.approx(4.00)
    assert by_ref["4306997877"].extra["market_type"] == str(MarketType.X12)
    assert by_ref["4306997877"].status is MarketStatus.ACTIVE
    assert by_ref["4306997877"].max_stake == 10000.0


def test_suspended_outcomes_are_not_quoted(adapter):
    refs = {u.selection_ref for u in adapter.parse_odds(FIXTURE, EVENT_REF)}
    assert "4306998800" in refs        # the open side of Draw No Bet
    assert "4306998801" not in refs    # the SUSPENDED side


def test_totals_outcomes_carry_their_own_line(adapter):
    by_ref = {u.selection_ref: u for u in adapter.parse_odds(FIXTURE, EVENT_REF)}
    assert by_ref["4306998001"].line == pytest.approx(1.5)
    assert by_ref["4306998003"].line == pytest.approx(3.5)


def test_the_1x2_book_from_the_live_capture_has_no_arb(adapter):
    """Sanity anchor: 1.96 / 3.30 / 4.00 is a real Sunbet price, and a normal
    overround. If this ever reads < 1 the parser has mangled the wire format."""
    from oddsengine.arbmath import margin

    odds = [u.decimal_odds for u in adapter.parse_odds(FIXTURE, EVENT_REF)
            if u.market_ref == "2683078519"]
    assert len(odds) == 3
    assert margin(odds) < 0                     # book holds a margin, as it must
    assert sum(1 / o for o in odds) == pytest.approx(1.0632, abs=1e-3)


# ------------------------------------------------------------------- rules

def test_settlement_basis_is_derived_from_the_labels_kambi_publishes(adapter):
    p = adapter.rules_profile
    assert p.soccer_duration == "REG_90"
    assert p.basketball_ot == "INCLUDED"     # only "- Including Overtime" offers map
    assert p.tennis_retirement == UNVERIFIED  # not in the payload; needs the T&Cs


def test_rugby_overtime_variants_are_not_in_the_allowlist():
    keys = {label for (_sport, _tid, label) in KAMBI_ALLOWLIST}
    assert "regular time" in keys
    assert not any("including overtime" in k for k in keys
                   if (Sport.RUGBY, 2, k) in KAMBI_ALLOWLIST)
