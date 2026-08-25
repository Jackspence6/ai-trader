"""Single-process dev server: simulated live venues + engine + API on :8000.

    python -m oddsengine.services.dev     (or: make dev)

Gives the dashboard a live WebSocket feed with no Docker/DB/Redis: mock odds
random-walk around the §14.1 scenarios so arbs continuously appear, improve and
expire. This is the fastest way to see the whole terminal working locally.
"""

from __future__ import annotations

import asyncio
import random

import uvicorn

from ..bus import MemoryBus
from ..config import load_config
from ..observability import configure_logging, get_logger
from ..services.alerter import Alerter
from ..services.api.app import create_app
from ..simulation import build_world, ingest_catalogue, run_tick, script_timeline, seed_fixtures
from ..state import MemoryState
from ..venues.mock import ScriptedUpdate

log = get_logger("dev")


async def _random_walk(world, start_tick: int) -> None:
    """After the scripted ticks, keep books drifting so the dashboard stays alive."""
    beta = world.venues["betmock_a"]
    bravo = world.venues["betmock_b"]
    charlie = world.venues["betmock_c"]
    pm = world.venues["polymarket"]
    tick = start_tick
    home_odds = 2.30
    p1_odds = 2.02
    pm_yes = 0.50
    while True:
        tick += 1
        home_odds = min(2.55, max(2.10, home_odds + random.uniform(-0.06, 0.07)))
        p1_odds = min(2.16, max(1.90, p1_odds + random.uniform(-0.04, 0.05)))
        pm_yes = min(0.56, max(0.44, pm_yes + random.uniform(-0.012, 0.012)))
        beta.script_update(ScriptedUpdate(tick, "a-psl1", "a-psl1-1x2", "a-psl1-h",
                                          decimal_odds=round(home_odds, 2)))
        bravo.script_update(ScriptedUpdate(tick, "b-psl1", "b-psl1-1x2", "b-psl1-d",
                                           decimal_odds=round(3.55 + random.uniform(-0.15, 0.3), 2)))
        charlie.script_update(ScriptedUpdate(tick, "c-psl1", "c-psl1-1x2", "c-psl1-a",
                                             decimal_odds=round(3.35 + random.uniform(-0.15, 0.25), 2)))
        beta.script_update(ScriptedUpdate(tick, "a-wta1", "a-wta1-ml", "a-wta1-p1",
                                          decimal_odds=round(p1_odds, 2)))
        bravo.script_update(ScriptedUpdate(tick, "b-wta1", "b-wta1-ml", "b-wta1-p2",
                                           decimal_odds=round(4.05 - p1_odds + random.uniform(-0.03, 0.05), 2)))
        pm.script_update(ScriptedUpdate(tick, "pm-nba1", "pm-nba1-will-lakers", "tok-lal-yes",
                                        pm_buy_price=round(pm_yes, 3), pm_fee_rate=0.05,
                                        depth_shares=random.uniform(1500, 6000)))
        beta.script_update(ScriptedUpdate(tick, "a-nba1", "a-nba1-ml", "a-nba1-a",
                                          decimal_odds=round(1.0 / max(0.995 - pm_yes, 0.35)
                                                             * random.uniform(0.98, 1.04), 2),
                                          max_stake=15000))
        await run_tick(world, tick)
        await asyncio.sleep(2.0)


async def main(host: str = "0.0.0.0", port: int = 8000) -> None:
    configure_logging(level="INFO", json_output=False)
    cfg = load_config()
    state = MemoryState()
    bus = MemoryBus()
    world = build_world(cfg, state, bus)
    seed_fixtures(world)
    script_timeline(world)
    await ingest_catalogue(world)

    alerter = Alerter(cfg, state, bus)

    async def _alert_pump() -> None:
        async for payload in bus.subscribe("alerts"):
            await alerter.handle_alert(payload)

    async def _scripted_then_walk() -> None:
        for tick in range(0, 8):
            await run_tick(world, tick)
            await asyncio.sleep(1.5)
        await _random_walk(world, start_tick=8)

    async def _health_pump() -> None:
        while True:
            for adapter in world.venues.values():
                h = await adapter.health()
                await state.set_health(h)
            await asyncio.sleep(10)

    app = create_app(cfg, state, bus, world.registry)
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning"))
    log.info("dev_server_up", url=f"http://localhost:{port}", ws=f"ws://localhost:{port}/ws/opportunities")
    await asyncio.gather(server.serve(), _scripted_then_walk(), _alert_pump(), _health_pump())


if __name__ == "__main__":
    asyncio.run(main())
