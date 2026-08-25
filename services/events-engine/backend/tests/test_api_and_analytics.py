"""API surface + analytics/go-no-go + FX chaos case."""

import httpx
import pytest
from fastapi.testclient import TestClient

from oddsengine.analytics import summarize
from oddsengine.bus import MemoryBus
from oddsengine.config import FxConfig, load_config
from oddsengine.fx import FxService
from oddsengine.matching import CanonicalRegistry
from oddsengine.models import (
    Leg,
    Opportunity,
    OpportunityType,
    OppState,
    PlacementFeedback,
    Sport,
    TimingClass,
    Urgency,
    utcnow,
)
from oddsengine.services.api.app import create_app
from oddsengine.state import MemoryState


def make_opp(i: int, margin: float = 2.0, exec_zar: float = 5000.0,
             window: float | None = 120.0) -> Opportunity:
    return Opportunity(
        id=f"opp{i}", opp_type=OpportunityType.BOOKIE_BOOKIE, event_id=f"e{i}",
        event_label="A vs B", sport=Sport.SOCCER, league="Betway Premiership",
        market_key="1X2|", legs=[
            Leg(venue_id="a", venue_name="A", outcome="HOME", selection_label="A", odds=2.4,
                stake_zar=4300, order_index=1),
            Leg(venue_id="b", venue_name="B", outcome="AWAY", selection_label="B", odds=3.5,
                stake_zar=2950, order_index=2),
        ],
        margin_pct=margin, executable_zar_per_leg=exec_zar, guaranteed_profit_zar=320.0,
        urgency=Urgency.LOW, timing=TimingClass.PRE_MATCH,
        state=OppState.EXPIRED if window else OppState.ACTIVE, window_s=window,
        first_seen=utcnow(), last_seen=utcnow(),
    )


def test_analytics_summary_and_go_no_go():
    opps = [make_opp(i) for i in range(6)] + [make_opp(9, margin=0.4)]      # one below-usable
    placements = [PlacementFeedback(opportunity_id="opp1", status="placed"),
                  PlacementFeedback(opportunity_id="opp2", status="missed")]
    s = summarize(opps, placements, {"pre_match": [30.0, 200.0]})
    assert s["opportunities_total"] == 7
    assert s["usable_total"] == 6
    assert s["go_no_go"] == "PENDING"          # one day observed < 14
    assert 0 < s["capture_rate"] <= 1
    assert s["theoretical_profit_zar"] > 0
    assert s["margin_histogram"] and s["window_histogram"]


@pytest.fixture
def client():
    state, bus = MemoryState(), MemoryBus()
    app = create_app(load_config(), state, bus, CanonicalRegistry())
    with TestClient(app) as tc:
        tc.hot_state = state
        yield tc


def test_api_basics(client):
    assert client.get("/health").json()["ok"] is True
    assert client.get("/opportunities").json() == []
    cfg = client.get("/config").json()
    assert "telegram_bot_token" not in cfg["alerts"]       # secrets never leak
    assert "db_url" not in cfg


def test_api_feedback_killswitch_metrics(client):
    r = client.post("/feedback", json={"opportunity_id": "x", "status": "placed",
                                       "actual_odds": 2.05, "actual_stake_zar": 5000})
    assert r.json()["ok"] is True
    r = client.post("/killswitch", json={"on": True})
    assert r.json()["kill_switch"] is True
    assert client.get("/health").json()["kill_switch"] is True
    assert "counters" in client.get("/metrics").json()
    assert client.get("/opportunities/nope").status_code == 404
    assert client.get("/analytics/summary").json()["opportunities_total"] == 0


async def test_fx_outage_keeps_last_known_rate():
    fx = FxService(FxConfig(fallback_rate=18.0))
    assert fx.rate == 18.0 and not fx.is_live
    fx.set_rate(18.5)
    assert fx.buffered_rate == pytest.approx(18.5 / 1.02)

    def _boom(request):  # noqa: ANN001
        raise httpx.ConnectError("network down", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(_boom))
    ok = await fx.refresh(client)
    await client.aclose()
    assert ok is False
    assert fx.rate == 18.5                                  # FX outage: last-known kept

    def _good(request):  # noqa: ANN001
        return httpx.Response(200, json={"rates": {"ZAR": 17.9}})

    client = httpx.AsyncClient(transport=httpx.MockTransport(_good))
    assert await fx.refresh(client) is True
    await client.aclose()
    assert fx.rate == 17.9 and fx.is_live


def test_zar_usd_conversions_conservative():
    fx = FxService(FxConfig(buffer_pct=2.0))
    fx.set_rate(18.0)
    assert fx.usd_to_zar(100) < 1800.0                      # haircut payouts
    assert fx.zar_to_usd(1800) > 100.0                      # inflate required USD
