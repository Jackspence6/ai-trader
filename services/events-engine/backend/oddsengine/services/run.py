"""Uniform service entrypoint for the Compose deployment.

    python -m oddsengine.services.run ingest --venues polymarket
    python -m oddsengine.services.run normalizer
    python -m oddsengine.services.run engine
    python -m oddsengine.services.run alerter
    python -m oddsengine.services.run scheduler

Each service builds redis-backed state + bus from env (STATE_BACKEND/REDIS_URL) and
runs forever. Canonical event ids are deterministic content hashes, so independent
processes converge on the same ids from the same raw_events stream.
"""

from __future__ import annotations

import argparse
import asyncio

from ..bus import make_bus
from ..config import load_config
from ..db import Database
from ..fx import FxService
from ..matching import CanonicalRegistry, EventMatcher
from ..models import RawEvent
from ..observability import configure_logging, get_logger
from ..state import make_state
from ..venues.factory import build_adapters
from .alerter import Alerter
from .engine import ArbEngine
from .ingest import IngestService
from .normalizer import Normalizer
from .scheduler import Scheduler

log = get_logger("run")


async def _maybe_db(cfg):
    if not cfg.db_url:
        return None
    try:
        return await Database.connect(cfg.db_url)
    except Exception as exc:  # noqa: BLE001
        log.error("db_connect_failed", error=str(exc))
        return None


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("service", choices=["ingest", "normalizer", "engine", "alerter", "scheduler"])
    parser.add_argument("--venues", default=None, help="comma-separated venue ids (ingest only)")
    args = parser.parse_args()

    cfg = load_config()
    configure_logging(cfg.log_level)
    state = make_state(cfg.state_backend, cfg.redis_url)
    bus = make_bus(cfg.state_backend, cfg.redis_url)
    fx = FxService(cfg.fx)

    if args.service == "ingest":
        only = args.venues.split(",") if args.venues else None
        adapters = build_adapters(cfg, only)
        log.info("ingest_starting", venues=list(adapters))
        await IngestService(cfg, adapters, state, bus).run()

    elif args.service == "normalizer":
        adapters = build_adapters(cfg)
        registry = CanonicalRegistry()
        matcher = EventMatcher(registry, cfg.matching)
        db = await _maybe_db(cfg)
        await fx.refresh()
        await Normalizer(cfg, registry, matcher, adapters, state, bus, fx, db).run()

    elif args.service == "engine":
        adapters = build_adapters(cfg)
        registry = CanonicalRegistry()
        matcher = EventMatcher(registry, cfg.matching)
        db = await _maybe_db(cfg)
        engine = ArbEngine(cfg, state, bus, fx, adapters, registry, db)

        async def _track_events() -> None:
            async for payload in bus.subscribe("raw_events"):
                matcher.match(RawEvent.model_validate(payload))

        await asyncio.gather(engine.run(), _track_events())

    elif args.service == "alerter":
        await Alerter(cfg, state, bus).run()

    elif args.service == "scheduler":
        adapters = build_adapters(cfg)
        db = await _maybe_db(cfg)
        await Scheduler(cfg, state, bus, fx, adapters, db).run()


if __name__ == "__main__":
    asyncio.run(main())
