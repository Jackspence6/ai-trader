"""HAR analyser tests (spec §3.2 endpoint discovery).

Built around a synthetic HAR that contains what a real sportsbook capture contains:
an odds feed, a Kambi-style milli-decimal feed, a WebSocket price stream, and a pile
of analytics/asset noise that must not be mistaken for any of it.
"""

import json

import pytest

from oddsengine.discovery import (
    analyse_har,
    describe_shape,
    looks_like_decimal_odds,
    looks_like_milli_odds,
    render_report,
    score_payload,
    suggest_config,
)


def entry(url, payload, *, mime="application/json", status=200, method="GET", headers=None,
          ws_messages=None):
    e = {
        "request": {"url": url, "method": method,
                    "headers": [{"name": k, "value": v} for k, v in (headers or {}).items()]},
        "response": {"status": status,
                     "content": {"mimeType": mime,
                                 "text": json.dumps(payload) if payload is not None else ""}},
    }
    if ws_messages:
        e["_webSocketMessages"] = [{"data": json.dumps(m)} for m in ws_messages]
    return e


ODDS_FEED = {
    "events": [
        {
            "id": 8811,
            "homeTeam": "Mamelodi Sundowns",
            "awayTeam": "Orlando Pirates",
            "startTime": "2026-08-25T17:00:00Z",
            "markets": [
                {"name": "Match Result", "suspended": False, "selections": [
                    {"id": 1, "name": "Sundowns", "odds": 2.40},
                    {"id": 2, "name": "Draw", "odds": 3.80},
                    {"id": 3, "name": "Pirates", "odds": 3.50},
                ]},
            ],
        },
    ],
}

KAMBI_FEED = {
    "betOffers": [
        {"id": 5, "criterion": {"label": "Match"}, "outcomes": [
            {"id": 51, "label": "1", "odds": 2400},
            {"id": 52, "label": "X", "odds": 3800},
            {"id": 53, "label": "2", "odds": 3500},
        ]},
    ],
}

NOISE = {"sessionId": "abc", "pageLoadMs": 1423, "userAgent": "x"}


@pytest.fixture
def har(tmp_path):
    log = {"log": {"entries": [
        entry("https://cdn.example.com/analytics/collect", NOISE),
        entry("https://www.book.co.za/assets/logo.png", None, mime="image/png"),
        entry("https://sports-api.book.co.za/v2/events/soccer", ODDS_FEED),
        entry("https://sports-api.book.co.za/v2/event/8811/markets", ODDS_FEED,
              headers={"Authorization": "Bearer secret-token-value", "Accept": "application/json"}),
        entry("https://offering.kambicdn.org/offering/v2018/sunbet/betoffer/event/1.json", KAMBI_FEED),
        entry("wss://push.book.co.za/stream", None, mime="",
              ws_messages=[{"selections": [{"id": 1, "odds": 2.45}, {"id": 2, "odds": 3.75}]}]),
        entry("https://www.book.co.za/api/telemetry", NOISE),
    ]}}
    p = tmp_path / "capture.har"
    p.write_text(json.dumps(log))
    return p


# ------------------------------------------------------------ value shapes

def test_decimal_and_milli_odds_recognition():
    assert looks_like_decimal_odds(2.40)
    assert looks_like_decimal_odds(1.01)
    assert not looks_like_decimal_odds(2)        # whole numbers are ids, not odds
    assert not looks_like_decimal_odds(0.95)     # below any real decimal price
    assert not looks_like_decimal_odds(True)     # bools are not odds
    assert not looks_like_decimal_odds("2.40")

    assert looks_like_milli_odds(2400)
    assert not looks_like_milli_odds(5)
    assert not looks_like_milli_odds(2_000_000)  # that's a timestamp or an id


def test_scoring_separates_odds_feeds_from_noise():
    odds_score, _, keys, _ = score_payload(ODDS_FEED)
    noise_score, _, _, _ = score_payload(NOISE)
    assert odds_score > noise_score * 5
    assert "odds" in keys and "selections" in keys


def test_milli_format_is_detected():
    _, _, _, milli = score_payload(KAMBI_FEED)
    assert milli, "integer milli-decimal odds should be flagged so the parser divides by 1000"


# ---------------------------------------------------------------- analysis

def test_finds_the_odds_endpoints_and_ignores_the_noise(har):
    cands = analyse_har(har)
    urls = [c.url for c in cands]
    assert any("sports-api.book.co.za" in u for u in urls)
    assert not any("analytics" in u or "telemetry" in u or ".png" in u for u in urls)


def test_ranks_the_richest_feed_first(har):
    cands = analyse_har(har)
    assert cands[0].odds_like_values > 0
    assert cands[0].score >= cands[-1].score


def test_websocket_streams_are_surfaced(har):
    cands = analyse_har(har)
    ws = [c for c in cands if c.is_websocket]
    assert ws, "a push feed is the best possible source and must not be missed"
    assert ws[0].url.startswith("wss://")


def test_credentials_are_flagged_but_never_echoed(har):
    cands = analyse_har(har)
    with_auth = [c for c in cands if c.auth_headers]
    assert with_auth, "an endpoint needing an Authorization header must be flagged"
    report = render_report("book", cands)
    assert "Authorization" in report
    assert "secret-token-value" not in report, "header VALUES must never be printed"


def test_repeated_polling_of_one_endpoint_collapses(tmp_path):
    log = {"log": {"entries": [
        entry(f"https://api.book.co.za/v2/event/{i}/markets", ODDS_FEED) for i in range(1000, 1010)
    ]}}
    p = tmp_path / "poll.har"
    p.write_text(json.dumps(log))
    assert len(analyse_har(p)) == 1, "ten polls of one endpoint are one candidate"


def test_empty_capture_says_so_rather_than_guessing(tmp_path):
    p = tmp_path / "empty.har"
    p.write_text(json.dumps({"log": {"entries": [entry("https://x.co/analytics", NOISE)]}}))
    cands = analyse_har(p)
    assert cands == []
    report = render_report("betway_sa", cands)
    assert "Nothing in this capture looks like an odds feed" in report
    assert "Preserve log" in report, "the report should say how to get a better capture"


# ------------------------------------------------------------------ output

def test_suggested_config_is_pasteable_and_disabled_by_default(har):
    cfg = suggest_config("betway_sa", analyse_har(har))
    assert "betway_sa:" in cfg
    assert "enabled: false" in cfg, "never auto-enable a venue from a guess"
    assert "events_url:" in cfg
    assert "secret-token-value" not in cfg
    assert "REDACTED" in cfg


def test_config_templates_event_ids_into_a_placeholder(har):
    cfg = suggest_config("book", analyse_har(har))
    assert "{event_ref}" in cfg


def test_shape_sketch_is_readable_and_bounded():
    shape = describe_shape(ODDS_FEED)
    assert "events:" in shape
    deep = describe_shape({"a": {"b": {"c": {"d": {"e": 1}}}}}, max_depth=2)
    assert "..." in deep, "the sketch must terminate rather than dumping a whole payload"
