"""Ingestion orchestrator: runs venue adapters, publishes raw payloads to the bus.

Per adapter:
- discovery loop (events + markets) every discovery_interval
- polling loop for poll-only venues, accelerating near kickoff (spec §2 latency budget)
- stream consumer for WS venues (Polymarket)
- health reporting; AdapterNotConfigured venues report UNCONFIGURED and idle.
"""

from __future__ import annotations

import asyncio
import random
from datetime import timedelta

from ..config import AppConfig
from ..models import HealthState, HealthStatus, utcnow
from ..observability import METRICS, get_logger
from ..venues.base import AdapterNotConfigured, VenueAdapter

log = get_logger("ingest")

DISCOVERY_INTERVAL_S = 300.0
HEALTH_INTERVAL_S = 30.0


class IngestService:
    def __init__(self, cfg: AppConfig, adapters: dict[str, VenueAdapter], state, bus) -> None:
        self.cfg = cfg
        self.adapters = adapters
        self.state = state
        self.bus = bus
        self._event_refs: dict[str, dict[str, object]] = {}  # venue -> {event_ref: start_time}

    async def _discover(self, venue_id: str, adapter: VenueAdapter) -> None:
        while True:
            try:
                events = await adapter.discover_events("*")
                refs: dict[str, object] = {}
                for ev in events:
                    refs[ev.ref] = ev.start_time
                    await self.bus.publish("raw_events", ev.model_dump(mode="json"))
                    markets = await adapter.fetch_markets(ev.ref)
                    for m in markets:
                        await self.bus.publish("raw_markets", m.model_dump(mode="json"))
                self._event_refs[venue_id] = refs
                METRICS.inc("ingest.discoveries")
                log.info("discovered", venue=venue_id, events=len(events))
            except AdapterNotConfigured as exc:
                await self.state.set_health(HealthStatus(
                    venue_id=venue_id, state=HealthState.UNCONFIGURED, note=str(exc)))
                log.info("venue_unconfigured", venue=venue_id)
                await asyncio.sleep(3600)
                continue
            except Exception as exc:  # noqa: BLE001
                log.error("discovery_failed", venue=venue_id, error=str(exc))
            await asyncio.sleep(DISCOVERY_INTERVAL_S * (1 + random.uniform(0, 0.2)))

    def _poll_interval(self, start_time) -> float:
        p = self.cfg.polling
        if start_time is not None:
            try:
                if (start_time - utcnow()) <= timedelta(minutes=p.near_kickoff_window_min):
                    return p.near_kickoff_interval_s
            except TypeError:
                pass
        return p.default_interval_s

    async def _poll(self, venue_id: str, adapter: VenueAdapter) -> None:
        while True:
            refs = self._event_refs.get(venue_id, {})
            if not refs:
                await asyncio.sleep(5)
                continue
            for ref, _start_time in list(refs.items()):
                try:
                    updates = await adapter.fetch_odds(ref)
                    for upd in updates:
                        await self.bus.publish("raw_odds", upd.model_dump(mode="json"))
                        METRICS.inc("ingest.odds_updates")
                except AdapterNotConfigured:
                    break
                except Exception as exc:  # noqa: BLE001
                    log.warning("poll_failed", venue=venue_id, event_ref=ref, error=str(exc))
            interval = min((self._poll_interval(st) for st in refs.values()),
                           default=self.cfg.polling.default_interval_s)
            await asyncio.sleep(interval * (1 + random.uniform(0, self.cfg.polling.jitter_frac)))

    async def _stream(self, venue_id: str, adapter: VenueAdapter) -> None:
        stream = adapter.stream()
        if stream is None:
            return
        async for upd in stream:
            await self.bus.publish("raw_odds", upd.model_dump(mode="json"))
            METRICS.inc("ingest.stream_updates")

    async def _health(self, venue_id: str, adapter: VenueAdapter) -> None:
        while True:
            try:
                h = await adapter.health()
                await self.state.set_health(h)
                await self.bus.publish("health", h.model_dump(mode="json"))
            except Exception as exc:  # noqa: BLE001
                log.warning("health_check_failed", venue=venue_id, error=str(exc))
            await asyncio.sleep(HEALTH_INTERVAL_S)

    async def run(self) -> None:
        tasks = []
        for venue_id, adapter in self.adapters.items():
            tasks.append(self._discover(venue_id, adapter))
            tasks.append(self._health(venue_id, adapter))
            if getattr(adapter, "is_streaming", False):
                tasks.append(self._stream(venue_id, adapter))
            else:
                tasks.append(self._poll(venue_id, adapter))
        if not tasks:
            log.warning("no_adapters_enabled")
            return
        await asyncio.gather(*tasks)
