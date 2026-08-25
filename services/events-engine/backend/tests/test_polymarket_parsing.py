"""Defensive Polymarket parsing — the spec's named chaos cases (§3.4, §10):
prices as JSON strings, side/array inversion, negRisk missing, garbage frames."""

import json

from oddsengine.venues.polymarket.parsing import (
    as_list,
    parse_book,
    parse_fee_rate,
    parse_gamma_market,
    parse_ws_messages,
)
from oddsengine.venues.polymarket.ws import MarketChannelConsumer

GAMMA_MARKET_STRINGY = {
    "conditionId": "0xc0ffee",
    "question": "Will the Lakers beat the Celtics?",
    "slug": "lakers-celtics",
    # Gamma frequently returns these as JSON-encoded strings, not arrays:
    "outcomes": '["Yes", "No"]',
    "outcomePrices": '["0.485", "0.515"]',
    "clobTokenIds": '["111", "222"]',
    "closed": "false",
    # negRisk deliberately MISSING (chaos case)
}


def test_as_list_handles_stringified_arrays():
    assert as_list('["a", "b"]') == ["a", "b"]
    assert as_list(["a"]) == ["a"]
    assert as_list(None) == []
    assert as_list("not json") == []
    assert as_list(42) == []


def test_gamma_market_stringy_fields_and_missing_negrisk():
    pm = parse_gamma_market(GAMMA_MARKET_STRINGY, event={"id": "9", "title": "Lakers vs. Celtics",
                                                         "tags": '["nba"]'})
    assert pm is not None
    assert pm.outcomes == ["Yes", "No"]
    assert pm.outcome_prices == [0.485, 0.515]
    assert pm.token_ids == ["111", "222"]
    assert pm.neg_risk is False              # missing flag -> False, never a crash
    assert pm.category == "nba"
    assert pm.event_title == "Lakers vs. Celtics"


def test_gamma_market_without_tokens_rejected():
    assert parse_gamma_market({"conditionId": "0x1", "clobTokenIds": "[]"}) is None


def test_book_resorts_unordered_sides():
    book = parse_book({
        "asset_id": "111",
        # asks listed high-to-low, bids low-to-high, string prices: all must be re-sorted
        "asks": [{"price": "0.55", "size": "10"}, {"price": "0.52", "size": "5"}],
        "bids": [{"price": "0.40", "size": "3"}, {"price": "0.48", "size": "7"}],
    })
    assert book is not None
    assert book.best_ask == 0.52 and book.best_bid == 0.48
    assert [level.price for level in book.asks] == [0.52, 0.55]
    assert [level.price for level in book.bids] == [0.48, 0.40]


def test_crossed_book_rejected_as_side_inversion():
    # bids above asks = we (or the feed) inverted sides; must be dropped, not traded on
    book = parse_book({"asset_id": "111",
                       "asks": [{"price": "0.40", "size": "1"}],
                       "bids": [{"price": "0.60", "size": "1"}]})
    assert book is None


def test_book_accepts_tuple_levels_and_drops_garbage():
    book = parse_book({"token_id": "t", "asks": [["0.5", "10"], ["bad", "x"], ["0.51"]],
                       "bids": []})
    assert book is not None and len(book.asks) == 1


def test_ws_frames_object_array_and_garbage():
    assert parse_ws_messages(json.dumps({"event_type": "book"})) == [{"event_type": "book"}]
    assert len(parse_ws_messages(json.dumps([{"a": 1}, {"b": 2}]))) == 2
    assert parse_ws_messages("not json at all") == []
    assert parse_ws_messages(json.dumps("just a string")) == []


def test_price_change_folds_into_local_book():
    consumer = MarketChannelConsumer("wss://example/ws/")
    local: dict = {}
    snap = consumer._handle({"event_type": "book", "asset_id": "111",
                             "asks": [{"price": "0.52", "size": "5"}],
                             "bids": [{"price": "0.48", "size": "5"}]}, local)
    assert snap is not None
    # delta BEFORE any snapshot for an unknown token is ignored (no fabrication)
    assert consumer._handle({"event_type": "price_change", "asset_id": "999",
                             "changes": [{"price": "0.5", "size": "1", "side": "SELL"}]}, local) is None
    updated = consumer._handle({"event_type": "price_change", "asset_id": "111",
                                "changes": [{"price": "0.51", "size": "9", "side": "SELL"},
                                            {"price": "0.48", "size": "0", "side": "BUY"}]}, local)
    assert updated is not None
    assert updated.best_ask == 0.51           # new level inserted + re-sorted
    assert updated.best_bid is None           # size 0 removes the bid level


def test_fee_rate_spellings():
    assert parse_fee_rate({"fee_rate_bps": 500}, 0.03) == 0.05
    assert parse_fee_rate({"feeRateBps": "400"}, 0.03) == 0.04
    assert parse_fee_rate({"fee_rate": 0.07}, 0.03) == 0.07
    assert parse_fee_rate(700, 0.03) == 0.07          # bare bps number
    assert parse_fee_rate(0.05, 0.03) == 0.05         # bare fraction
    assert parse_fee_rate({"unexpected": True}, 0.03) == 0.03
    assert parse_fee_rate(None, 0.03) == 0.03
    assert parse_fee_rate("garbage", 0.03) == 0.03
