"""Pub/sub bus between services.

MemoryBus wires services in-process (demo, tests, single-process dev).
RedisBus carries the same topics across containers in the Compose deployment.

Topics:
    raw_events    RawEvent            adapters -> normalizer
    raw_markets   RawMarket           adapters -> normalizer
    raw_odds      RawOddsUpdate       adapters -> normalizer
    quotes        Quote               normalizer -> engine
    opportunities Opportunity         engine -> api/alerter
    alerts        alert payloads      engine -> alerter
    health        HealthStatus        adapters/scheduler -> api/ops
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from typing import Any, Protocol

TOPICS = ("raw_events", "raw_markets", "raw_odds", "quotes", "opportunities", "alerts", "health")


class Bus(Protocol):
    async def publish(self, topic: str, payload: dict[str, Any]) -> None: ...
    def subscribe(self, topic: str) -> AsyncIterator[dict[str, Any]]: ...
    async def close(self) -> None: ...


class MemoryBus:
    def __init__(self) -> None:
        self._subs: dict[str, list[asyncio.Queue]] = {t: [] for t in TOPICS}

    async def publish(self, topic: str, payload: dict[str, Any]) -> None:
        for q in self._subs.get(topic, []):
            await q.put(payload)

    async def _aiter(self, q: asyncio.Queue) -> AsyncIterator[dict[str, Any]]:
        while True:
            item = await q.get()
            if item is None:
                return
            yield item

    def subscribe(self, topic: str) -> AsyncIterator[dict[str, Any]]:
        q: asyncio.Queue = asyncio.Queue()
        self._subs.setdefault(topic, []).append(q)
        return self._aiter(q)

    async def close(self) -> None:
        for subs in self._subs.values():
            for q in subs:
                await q.put(None)


class RedisBus:
    def __init__(self, url: str, prefix: str = "oddsengine") -> None:
        import redis.asyncio as aioredis

        self._redis = aioredis.from_url(url, decode_responses=True)
        self._prefix = prefix

    def _chan(self, topic: str) -> str:
        return f"{self._prefix}:{topic}"

    async def publish(self, topic: str, payload: dict[str, Any]) -> None:
        await self._redis.publish(self._chan(topic), json.dumps(payload, default=str))

    async def _aiter(self, topic: str) -> AsyncIterator[dict[str, Any]]:
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(self._chan(topic))
        try:
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                with contextlib.suppress(json.JSONDecodeError):
                    yield json.loads(msg["data"])
        finally:
            await pubsub.unsubscribe(self._chan(topic))
            await pubsub.aclose()

    def subscribe(self, topic: str) -> AsyncIterator[dict[str, Any]]:
        return self._aiter(topic)

    async def close(self) -> None:
        await self._redis.aclose()


def make_bus(backend: str, redis_url: str) -> Bus:
    if backend == "redis":
        return RedisBus(redis_url)
    return MemoryBus()
