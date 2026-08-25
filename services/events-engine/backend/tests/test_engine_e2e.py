"""End-to-end pipeline test over the scripted §14.1 scenario (mock venues ->
normalizer -> engine -> alerts), including lifecycles and the fee-killed case."""

import asyncio

import pytest

from oddsengine.bus import MemoryBus
from oddsengine.config import load_config
from oddsengine.demo import _expected_examples
from oddsengine.models import OpportunityType, OppState
from oddsengine.simulation import build_world, ingest_catalogue, run_tick, script_timeline, seed_fixtures
from oddsengine.state import MemoryState


@pytest.fixture
async def scripted_world():
    cfg = load_config()  # falls back to defaults if config dir is absent
    state, bus = MemoryState(), MemoryBus()
    world = build_world(cfg, state, bus)
    seed_fixtures(world)
    script_timeline(world)
    alerts: list[dict] = []

    async def collect():
        async for a in bus.subscribe("alerts"):
            alerts.append(a)

    task = asyncio.create_task(collect())
    await ingest_catalogue(world)
    yield world, state, alerts
    task.cancel()


async def _drain():
    for _ in range(4):
        await asyncio.sleep(0)


async def test_full_timeline(scripted_world):
    world, state, alerts = scripted_world

    await run_tick(world, 0)
    assert await state.active_opportunities() == []      # baseline: no arbs

    # t1 — §14.1 three-way: 2.40/3.80/3.50 -> 3.44%, clean, bookie-vs-bookie
    emitted = await run_tick(world, 1)
    three_way = [o for o in emitted if o.market_key.startswith("1X2")]
    assert three_way, "1X2 arb should be detected"
    opp = three_way[0]
    assert opp.margin_pct == pytest.approx(3.44, abs=0.02)
    assert opp.opp_type == OpportunityType.BOOKIE_BOOKIE
    assert not opp.rule_risk
    assert len({leg.venue_id for leg in opp.legs}) == 3
    assert opp.guaranteed_profit_zar > 0 and opp.stakes_natural
    assert opp.executable_zar_per_leg >= 2000

    # t2 — tennis across incompatible retirement rules -> flagged, never "pure"
    emitted = await run_tick(world, 2)
    tennis = [o for o in emitted if o.sport.value == "tennis"]
    assert tennis and tennis[0].rule_risk
    assert "rules" in (tennis[0].rule_risk_note or "").lower() or tennis[0].rule_risk_note
    ruled_id = tennis[0].id
    # Kelly haircut applied to risky sizing (spec §5)
    assert tennis[0].total_stake_zar <= world.cfg.engine.total_stake_default_zar * \
        world.cfg.engine.kelly_fraction + 100

    # t3 — same-rules book arrives -> clean arb replaces the rule-risk one
    emitted = await run_tick(world, 3)
    clean_tennis = [o for o in emitted if o.sport.value == "tennis" and not o.rule_risk]
    assert clean_tennis
    old = await state.get_opportunity(ruled_id)
    assert old is not None and old.state == OppState.EXPIRED and old.window_s is not None

    # t4 — bookie vs Polymarket at §14.1 numbers (~1.1% after fees, before FX buffer)
    emitted = await run_tick(world, 4)
    pm_opps = [o for o in emitted if o.opp_type == OpportunityType.BOOKIE_POLYMARKET]
    assert pm_opps
    pm_opp = pm_opps[0]
    assert pm_opp.margin_pct == pytest.approx(1.13, abs=0.05)
    legs = sorted(pm_opp.legs, key=lambda x: x.order_index)
    assert legs[0].is_pm is False and legs[-1].is_pm is True   # bookie first, PM last
    assert pm_opp.fx_rate is not None
    assert pm_opp.score_breakdown["fx_risk"] < 1.0

    # t5 — PM-internal YES+NO killed by fees: must NOT be flagged
    await run_tick(world, 5)
    assert not [o for o in await state.active_opportunities() if "pm-mention" in o.market_key]

    # t6 — negRisk full-set internal arb (~2.4%)
    emitted = await run_tick(world, 6)
    ngr = [o for o in emitted if o.market_key.startswith("NEGRISK")]
    assert ngr and ngr[0].opp_type == OpportunityType.POLYMARKET_INTERNAL
    assert ngr[0].margin_pct == pytest.approx(2.41, abs=0.1)
    assert len(ngr[0].legs) == 3

    # t7 — books move away: everything expires with measured windows
    await run_tick(world, 7)
    active = await state.active_opportunities()
    assert active == []
    allo = await state.all_opportunities()
    assert all(o.window_s is not None for o in allo if o.state == OppState.EXPIRED)
    assert state.window_samples, "window durations must be recorded for survival models"

    # Alerts flowed for qualifying opportunities (dry-run measured everything)
    await _drain()
    assert len(alerts) >= 3
    checks = _expected_examples(allo)
    assert all(checks.values()), f"missing §14.1 examples: {checks}"


async def test_kill_switch_suppresses_alerts_not_measurement(scripted_world):
    world, state, alerts = scripted_world
    await state.set_kill_switch(True)
    await run_tick(world, 0)
    await run_tick(world, 1)
    await _drain()
    assert alerts == []                                   # no alerts under kill switch
    assert await state.active_opportunities()             # ...but still measured


async def test_suspended_and_stale_quotes_excluded(scripted_world):
    """Circuit-breaker behavior at quote level (spec §7): suspended and stale feeds
    never participate in detection, and losing a leg expires the opportunity."""
    from datetime import timedelta

    from oddsengine.models import MarketStatus, utcnow

    world, state, _ = scripted_world
    await run_tick(world, 0)
    emitted = await run_tick(world, 1)
    opp = next(o for o in emitted if o.market_key.startswith("1X2"))

    # Suspend the 2.40 HOME leg -> best home falls to 2.20 -> no arb -> opp expires
    cell = state.quotes[(opp.event_id, opp.market_key)]
    best_home = max((q for q in cell.values() if q.outcome == "HOME"), key=lambda q: q.odds_eff)
    best_home.status = MarketStatus.SUSPENDED
    await state.upsert_quote(best_home)
    assert await world.engine.recompute(opp.event_id, opp.market_key) == []
    stored = await state.get_opportunity(opp.id)
    assert stored.state == OppState.EXPIRED and stored.window_s is not None

    # Reactivate but make every quote stale -> still nothing detectable
    best_home.status = MarketStatus.ACTIVE
    for q in list(cell.values()):
        q.ts_ingest = utcnow() - timedelta(seconds=600)
        await state.upsert_quote(q)
    fresh = await world.engine._fresh(await state.get_quotes(opp.event_id, opp.market_key), utcnow())
    assert fresh == []
    assert await world.engine.recompute(opp.event_id, opp.market_key) == []
