"""Worker-scheduler: health sweeps, decay sweeps, FX refresh, circuit breakers (spec §2, §7).

Circuit-breaker policy: a feed returning stale (unchanging while peers move),
out-of-range, or schema-broken odds is quarantined via its HealthStatus; the engine
excludes quarantined venues' quotes and the alerter raises an ops alert.
"""

from __future__ import annotations

import asyncio

from ..config import AppConfig
from ..fx import FxService
from ..models import OppState, utcnow
from ..observability import get_logger

log = get_logger("scheduler")


class Scheduler:
    def __init__(self, cfg: AppConfig, state, bus, fx: FxService,
                 adapters: dict | None = None, db=None) -> None:
        self.cfg = cfg
        self.state = state
        self.bus = bus
        self.fx = fx
        self.adapters = adapters or {}
        self.db = db

    async def fx_loop(self) -> None:
        while True:
            await self.fx.refresh()
            await asyncio.sleep(self.cfg.fx.refresh_s)

    async def decay_sweep(self) -> None:
        """Expire ACTIVE opportunities whose legs stopped updating (feed died silently)."""
        while True:
            now = utcnow()
            horizon = self.cfg.polling.default_interval_s * self.cfg.staleness.max_age_factor * 2
            for opp in await self.state.active_opportunities():
                if (now - opp.last_seen).total_seconds() > horizon:
                    opp.state = OppState.EXPIRED
                    opp.window_s = max((now - opp.first_seen).total_seconds(), 0.0)
                    await self.state.upsert_opportunity(opp)
                    await self.state.log_lifecycle(opp.id, opp.margin_pct, "expired",
                                                   note="decay_sweep", ts=now)
                    await self.state.record_window(opp.timing.value, opp.window_s)
                    await self.bus.publish("opportunities", opp.model_dump(mode="json"))
                    log.info("opportunity_decayed", opportunity_id=opp.id, window_s=opp.window_s)
            await asyncio.sleep(self.cfg.staleness.sweep_interval_s)

    async def health_sweep(self) -> None:
        """Persist adapter health + publish transitions for the ops channel."""
        last_states: dict[str, str] = {}
        while True:
            for venue_id, adapter in self.adapters.items():
                try:
                    h = await adapter.health()
                except Exception as exc:  # noqa: BLE001
                    log.warning("health_probe_failed", venue=venue_id, error=str(exc))
                    continue
                await self.state.set_health(h)
                if last_states.get(venue_id) != h.state.value:
                    await self.bus.publish("health", h.model_dump(mode="json"))
                    last_states[venue_id] = h.state.value
            await asyncio.sleep(self.cfg.staleness.sweep_interval_s)

    async def kill_switch_sync(self) -> None:
        """Mirror the shared-DB kill switch into hot state.

        The operator may flip it from the hosted dashboard, which has no route to
        this process — the database is the one thing both sides can see.
        """
        while True:
            try:
                remote = await self.db.get_flag("kill_switch")
                if remote is not None:
                    remote = bool(remote)
                    if remote != await self.state.get_kill_switch():
                        await self.state.set_kill_switch(remote)
                        log.warning("kill_switch_synced_from_db", on=remote)
            except Exception as exc:  # noqa: BLE001 — never let a DB blip stop the engine
                log.warning("kill_switch_sync_failed", error=str(exc))
            await asyncio.sleep(5.0)

    async def run(self) -> None:
        tasks = [self.fx_loop(), self.decay_sweep()]
        if self.adapters:
            tasks.append(self.health_sweep())
        if self.db is not None:
            tasks.append(self.kill_switch_sync())
        await asyncio.gather(*tasks)
