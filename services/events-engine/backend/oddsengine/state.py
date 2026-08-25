"""Hot state: current quotes, active opportunities, venue health, dry-run measurement log.

MemoryState backs the demo/tests and single-process dev; RedisState backs the Compose
deployment (same interface, JSON-serialized). Postgres (db.py) is the durable layer —
hot state is always rebuildable from ingestion.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from .models import HealthStatus, Opportunity, OppState, PlacementFeedback, Quote, utcnow


class MemoryState:
    def __init__(self) -> None:
        # (event_id, market_key) -> {(outcome, venue_id, token_id): Quote}
        # token_id in the key keeps mirrored PM liquidity distinct (engine dedupes it).
        self.quotes: dict[tuple[str, str], dict[tuple[str, str, str], Quote]] = defaultdict(dict)
        self.opportunities: dict[str, Opportunity] = {}
        self.lifecycles: list[dict[str, Any]] = []
        self.health: dict[str, HealthStatus] = {}
        self.placements: list[PlacementFeedback] = []
        self.alerts_log: list[dict[str, Any]] = []
        self.window_samples: dict[str, list[float]] = defaultdict(list)  # timing -> durations
        self.kill_switch: bool = False

    # ------------------------------------------------------------- quotes
    async def upsert_quote(self, q: Quote) -> None:
        self.quotes[(q.event_id, q.market_key)][(q.outcome, q.venue_id, q.token_id or "")] = q

    async def get_quotes(self, event_id: str, mkey: str) -> list[Quote]:
        return list(self.quotes.get((event_id, mkey), {}).values())

    async def all_quote_keys(self) -> list[tuple[str, str]]:
        return list(self.quotes.keys())

    # ------------------------------------------------------- opportunities
    async def upsert_opportunity(self, opp: Opportunity) -> None:
        self.opportunities[opp.id] = opp

    async def get_opportunity(self, opp_id: str) -> Opportunity | None:
        return self.opportunities.get(opp_id)

    async def active_opportunities(self) -> list[Opportunity]:
        return [o for o in self.opportunities.values() if o.state == OppState.ACTIVE]

    async def all_opportunities(self) -> list[Opportunity]:
        return list(self.opportunities.values())

    async def log_lifecycle(self, opportunity_id: str, margin_pct: float, state: str,
                            note: str | None = None, ts: datetime | None = None) -> None:
        self.lifecycles.append({
            "opportunity_id": opportunity_id, "ts": (ts or utcnow()).isoformat(),
            "margin_pct": margin_pct, "state": state, "note": note,
        })

    async def record_window(self, timing: str, seconds: float) -> None:
        self.window_samples[timing].append(seconds)

    # ------------------------------------------------------------- health
    async def set_health(self, h: HealthStatus) -> None:
        self.health[h.venue_id] = h

    async def get_health(self) -> dict[str, HealthStatus]:
        return dict(self.health)

    # ----------------------------------------------------------- feedback
    async def add_placement(self, p: PlacementFeedback) -> None:
        self.placements.append(p)

    async def get_placements(self) -> list[PlacementFeedback]:
        return list(self.placements)

    async def log_alert(self, payload: dict[str, Any]) -> None:
        self.alerts_log.append(payload)

    # -------------------------------------------------------- kill switch
    async def set_kill_switch(self, on: bool) -> None:
        self.kill_switch = on

    async def get_kill_switch(self) -> bool:
        return self.kill_switch

    # ------------------------------------------------------------- export
    async def export_json(self, path: str | Path) -> None:
        """Dry-run dump for the go/no-go report (report.py) and later ML."""
        data = {
            "exported_at": utcnow().isoformat(),
            "opportunities": [o.model_dump(mode="json") for o in self.opportunities.values()],
            "lifecycles": self.lifecycles,
            "placements": [p.model_dump(mode="json") for p in self.placements],
            "alerts": self.alerts_log,
            "window_samples": dict(self.window_samples),
            "health": {k: v.model_dump(mode="json") for k, v in self.health.items()},
        }
        Path(path).write_text(json.dumps(data, indent=2, default=str))


class RedisState:
    """Redis-backed implementation of the same interface (Compose deployment)."""

    def __init__(self, url: str, prefix: str = "oe") -> None:
        import redis.asyncio as aioredis

        self.r = aioredis.from_url(url, decode_responses=True)
        self.p = prefix

    def _k(self, *parts: str) -> str:
        return ":".join((self.p, *parts))

    async def upsert_quote(self, q: Quote) -> None:
        await self.r.hset(self._k("quotes", q.event_id, q.market_key),
                          f"{q.outcome}|{q.venue_id}|{q.token_id or ''}", q.model_dump_json())
        await self.r.sadd(self._k("quotekeys"), f"{q.event_id}||{q.market_key}")

    async def get_quotes(self, event_id: str, mkey: str) -> list[Quote]:
        raw = await self.r.hgetall(self._k("quotes", event_id, mkey))
        return [Quote.model_validate_json(v) for v in raw.values()]

    async def all_quote_keys(self) -> list[tuple[str, str]]:
        keys = await self.r.smembers(self._k("quotekeys"))
        return [tuple(k.split("||", 1)) for k in keys]  # type: ignore[misc]

    async def upsert_opportunity(self, opp: Opportunity) -> None:
        await self.r.hset(self._k("opps"), opp.id, opp.model_dump_json())

    async def get_opportunity(self, opp_id: str) -> Opportunity | None:
        raw = await self.r.hget(self._k("opps"), opp_id)
        return Opportunity.model_validate_json(raw) if raw else None

    async def active_opportunities(self) -> list[Opportunity]:
        return [o for o in await self.all_opportunities() if o.state == OppState.ACTIVE]

    async def all_opportunities(self) -> list[Opportunity]:
        raw = await self.r.hgetall(self._k("opps"))
        return [Opportunity.model_validate_json(v) for v in raw.values()]

    async def log_lifecycle(self, opportunity_id: str, margin_pct: float, state: str,
                            note: str | None = None, ts: datetime | None = None) -> None:
        entry = json.dumps({"opportunity_id": opportunity_id, "ts": (ts or utcnow()).isoformat(),
                            "margin_pct": margin_pct, "state": state, "note": note})
        await self.r.lpush(self._k("lifecycles"), entry)
        await self.r.ltrim(self._k("lifecycles"), 0, 50_000)

    async def record_window(self, timing: str, seconds: float) -> None:
        await self.r.lpush(self._k("windows", timing), seconds)
        await self.r.ltrim(self._k("windows", timing), 0, 10_000)

    async def set_health(self, h: HealthStatus) -> None:
        await self.r.hset(self._k("health"), h.venue_id, h.model_dump_json())

    async def get_health(self) -> dict[str, HealthStatus]:
        raw = await self.r.hgetall(self._k("health"))
        return {k: HealthStatus.model_validate_json(v) for k, v in raw.items()}

    async def add_placement(self, p: PlacementFeedback) -> None:
        await self.r.lpush(self._k("placements"), p.model_dump_json())

    async def get_placements(self) -> list[PlacementFeedback]:
        raw = await self.r.lrange(self._k("placements"), 0, -1)
        return [PlacementFeedback.model_validate_json(v) for v in raw]

    async def log_alert(self, payload: dict[str, Any]) -> None:
        await self.r.lpush(self._k("alerts"), json.dumps(payload, default=str))
        await self.r.ltrim(self._k("alerts"), 0, 10_000)

    async def set_kill_switch(self, on: bool) -> None:
        await self.r.set(self._k("kill"), "1" if on else "0")

    async def get_kill_switch(self) -> bool:
        return (await self.r.get(self._k("kill"))) == "1"

    async def export_json(self, path: str | Path) -> None:
        opps = await self.all_opportunities()
        placements = await self.get_placements()
        health = await self.get_health()
        raw_lc = await self.r.lrange(self._k("lifecycles"), 0, -1)
        data = {
            "exported_at": utcnow().isoformat(),
            "opportunities": [o.model_dump(mode="json") for o in opps],
            "lifecycles": [json.loads(x) for x in raw_lc],
            "placements": [p.model_dump(mode="json") for p in placements],
            "alerts": [],
            "window_samples": {},
            "health": {k: v.model_dump(mode="json") for k, v in health.items()},
        }
        Path(path).write_text(json.dumps(data, indent=2, default=str))


State = MemoryState | RedisState


def make_state(backend: str, redis_url: str) -> State:
    if backend == "redis":
        return RedisState(redis_url)
    return MemoryState()
