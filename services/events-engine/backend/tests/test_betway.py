"""Betway SA adapter tests.

The fixture is a trimmed live capture (2026-08-25) of the soccer board. Like the
Kambi one it is deliberately adversarial: it contains the empty per-line shells,
the squashed totals ladder, a 1st-half market wearing the same market name, and a
suspended book — all of which look mappable and are not.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from oddsengine.models import MarketStatus, MarketType, Sport
from oddsengine.rules import UNVERIFIED
from oddsengine.venues.betway import BetwaySAAdapter
from oddsengine.venues.betway.adapter import classify_market

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "betway_soccer_highlights.json").read_text())
EVENT = "73394738"

ENDPOINTS = {"highlights_url": "https://www.betway.co.za/sportsapi/br/v1/BetBook/Highlights/"}


@pytest.fixture
def adapter() -> BetwaySAAdapter:
    return BetwaySAAdapter(endpoints=dict(ENDPOINTS), enabled=True)


def market(mid: str) -> dict:
    return next(m for m in FIXTURE["markets"] if m["marketId"] == mid)


# -------------------------------------------------------------------- events

def test_parse_events_reads_the_board(adapter):
    events = adapter.parse_events(FIXTURE)
    assert [e.ref for e in events] == [EVENT]        # the outright is dropped
    ev = events[0]
    assert ev.sport is Sport.SOCCER
    assert ev.home_raw == "Sabah Masazir"
    assert ev.away_raw == "Hapoel Be`er Sheva FC"
    assert ev.league_raw == "UEFA Champions League"
    assert ev.start_time is not None and ev.start_time.tzinfo is not None


def test_epoch_start_times_are_utc(adapter):
    ev = adapter.parse_events(FIXTURE)[0]
    assert ev.start_time.year == 2026        # 1787676300 -> 2026-08-25T21:25Z
    assert ev.start_time.utcoffset().total_seconds() == 0


# ------------------------------------------------------- the settlement gate

def test_regular_play_markets_map():
    assert classify_market(market("733947381"), Sport.SOCCER).market_type is MarketType.X12
    assert classify_market(market("7339473829"), Sport.SOCCER).market_type is MarketType.BTTS
    assert classify_market(market("7339473818"), Sport.SOCCER).market_type is MarketType.TOTALS


def test_first_half_total_is_refused_despite_the_same_market_name():
    """Identical marketTypeCName and display name; only the provider group differs."""
    half = market("7339473877")
    assert half["marketTypeCName"] == market("7339473818")["marketTypeCName"]
    assert classify_market(half, Sport.SOCCER) is None


def test_markets_outside_the_allowlist_are_refused():
    assert classify_market(market("7339473844"), Sport.SOCCER) is None   # correct score


def test_a_market_is_refused_for_the_wrong_sport():
    assert classify_market(market("7339473829"), Sport.TENNIS) is None   # BTTS in tennis


# ------------------------------------------- the squashed totals ladder

def test_the_totals_ladder_is_split_into_one_market_per_line(adapter):
    """The whole ladder is published as one market carrying every line's outcomes.
    Pricing it as one book would read as an arb between Over 0.5 and Under 2.5."""
    totals = [m for m in adapter.parse_markets(FIXTURE, EVENT)
              if m.market_type is MarketType.TOTALS]
    assert sorted(m.line for m in totals) == [0.5, 1.5, 2.5]
    assert all(len(m.selections) == 2 for m in totals)
    assert {m.ref for m in totals} == {
        "7339473818total_0.5~", "7339473818total_1.5~", "7339473818total_2.5~"}


def test_each_split_market_keeps_only_its_own_two_outcomes(adapter):
    by_line = {m.line: m for m in adapter.parse_markets(FIXTURE, EVENT)
               if m.market_type is MarketType.TOTALS}
    refs = {o.selection_ref for o in adapter.parse_odds(FIXTURE, EVENT)
            if o.market_ref == by_line[2.5].ref}
    assert refs == {"7339473818total_2.5~12", "7339473818total_2.5~13"}


def test_empty_per_line_shells_are_dropped(adapter):
    """The child markets are listed alongside the parent but carry no outcomes."""
    refs = {m.ref for m in adapter.parse_markets(FIXTURE, EVENT)}
    published = {m.extra.get("published_market_id") for m in adapter.parse_markets(FIXTURE, EVENT)}
    assert "7339473818total_2.5~" in refs          # exists, from the split
    assert "7339473818total_2.5~" not in published  # never as a published market


def test_the_over_under_prices_survive_the_split(adapter):
    prices = {o.selection_ref: o.decimal_odds for o in adapter.parse_odds(FIXTURE, EVENT)}
    assert prices["7339473818total_2.5~12"] == pytest.approx(1.59)
    assert prices["7339473818total_2.5~13"] == pytest.approx(2.12)
    lines = {o.selection_ref: o.line for o in adapter.parse_odds(FIXTURE, EVENT)}
    assert lines["7339473818total_2.5~12"] == pytest.approx(2.5)


# --------------------------------------------------------------------- odds

def test_prices_are_plain_decimals_not_milli(adapter):
    prices = {o.selection_ref: o.decimal_odds for o in adapter.parse_odds(FIXTURE, EVENT)}
    assert prices["7339473811"] == pytest.approx(1.92)
    assert prices["7339473812"] == pytest.approx(3.80)
    assert prices["7339473813"] == pytest.approx(3.50)


def test_the_live_1x2_book_holds_a_normal_margin(adapter):
    from oddsengine.arbmath import margin

    odds = [o.decimal_odds for o in adapter.parse_odds(FIXTURE, EVENT)
            if o.market_ref == "733947381"]
    assert len(odds) == 3
    assert margin(odds) < 0
    assert sum(1 / o for o in odds) == pytest.approx(1.0697, abs=1e-3)


def test_refused_markets_are_never_priced(adapter):
    priced = {o.market_ref for o in adapter.parse_odds(FIXTURE)}
    assert "7339473844" not in priced                       # correct score
    assert not any(r.startswith("7339473877") for r in priced)  # 1st-half total


def test_suspended_market_is_flagged_not_dropped(adapter):
    updates = [o for o in adapter.parse_odds(FIXTURE) if o.market_ref == "733947399"]
    assert updates and all(u.status is MarketStatus.SUSPENDED for u in updates)


def test_outcomes_not_trading_are_dropped(adapter):
    refs = {o.selection_ref for o in adapter.parse_odds(FIXTURE)}
    assert "7339473991" in refs
    assert "7339473993" not in refs      # isTradingActive: false


def test_draw_and_over_under_carry_hints(adapter):
    hints = {s.name_raw: s.outcome_hint
             for m in adapter.parse_markets(FIXTURE, EVENT) for s in m.selections}
    assert hints["Draw"] == "X"
    assert hints["Over"] == "OVER"
    assert hints["Sabah Masazir"] == ""   # team names fall through to the name match


# ------------------------------------------------------------------- config

def test_market_filter_is_always_sent(adapter):
    """Omit marketTypes and the response comes back with no events key at all."""
    _url, params = adapter._url(Sport.SOCCER, take=50)
    keys = [k for k, _ in params]
    assert keys.count("marketTypes") == 3
    assert ("sportId", "soccer") in params
    assert ("countryCode", "ZA") in params


def test_unsupported_sports_are_refused(adapter):
    import asyncio
    with pytest.raises(ValueError):
        asyncio.run(adapter._board("cricket"))


def test_settlement_basis(adapter):
    assert adapter.rules_profile.soccer_duration == "REG_90"
    assert adapter.rules_profile.tennis_retirement == UNVERIFIED
