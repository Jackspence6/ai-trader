"""Common venue adapter interface (spec §3.1).

Adapters emit RawEvent / RawMarket / RawOddsUpdate; everything downstream is
venue-agnostic. Poll-only venues return None from stream().

Scraping conduct (spec §3.3) is enforced here: per-venue min request interval with
jitter, believable UA, public odds pages only — never login/account endpoints.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ..compat import UTC
from ..models import HealthState, HealthStatus, RawEvent, RawMarket, RawOddsUpdate, VenueKind
from ..rules import VenueRulesProfile

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class AdapterNotConfigured(RuntimeError):
    """Raised by skeleton adapters until endpoint discovery (ops/runbook.md) fills discovery.yaml."""


@dataclass
class VenueMeta:
    venue_id: str
    name: str
    kind: VenueKind
    currency: str = "ZAR"
    softness: float = 0.5              # prior: 0 sharp .. 1 soft (learned later, spec §13)
    min_interval_s: float = 20.0
    max_stake_default: float | None = 20000.0   # venue currency
    deep_link_template: str | None = None       # e.g. "https://venue/event/{event_ref}"
    homepage: str = ""
    enabled: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class VenueAdapter(Protocol):
    meta: VenueMeta
    rules_profile: VenueRulesProfile

    async def discover_events(self, sport: str) -> list[RawEvent]: ...
    async def fetch_markets(self, event_ref: str) -> list[RawMarket]: ...
    def stream(self) -> AsyncIterator[RawOddsUpdate] | None: ...
    async def fetch_odds(self, event_ref: str) -> list[RawOddsUpdate]: ...
    async def health(self) -> HealthStatus: ...
    def deep_link(self, event_ref: str, market_ref: str | None = None) -> str: ...


class BaseAdapter:
    """Shared plumbing: pacing, health accounting, deep links."""

    def __init__(self, meta: VenueMeta, rules_profile: VenueRulesProfile) -> None:
        self.meta = meta
        self.rules_profile = rules_profile
        self._last_request = 0.0
        self._errors_window: list[float] = []
        self._last_success: float | None = None
        self._consecutive_errors = 0

    async def pace(self) -> None:
        """Respect min request interval with jitter (anti-bot etiquette, spec §3.3)."""
        now = time.monotonic()
        wait = self.meta.min_interval_s * (1.0 + random.uniform(0.0, 0.25)) - (now - self._last_request)
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_request = time.monotonic()

    def note_success(self) -> None:
        self._last_success = time.time()
        self._consecutive_errors = 0

    def note_error(self) -> None:
        self._errors_window.append(time.time())
        self._consecutive_errors += 1
        cutoff = time.time() - 600
        self._errors_window = [t for t in self._errors_window if t > cutoff]

    async def health(self) -> HealthStatus:
        from datetime import datetime

        staleness = (time.time() - self._last_success) if self._last_success else None
        err_rate = len(self._errors_window) / max(1.0, 600.0 / max(self.meta.min_interval_s, 1.0))
        # Streaming venues only emit on book changes — a quiet book is not a dead feed,
        # so they get a much larger staleness floor than poll venues.
        stale_after = max(self.meta.min_interval_s * 3,
                          300.0 if getattr(self, "is_streaming", False) else 30.0)
        if not self.meta.enabled:
            state = HealthState.UNCONFIGURED
        elif self._consecutive_errors >= 5:
            state = HealthState.QUARANTINED
        elif staleness is not None and staleness > stale_after:
            state = HealthState.STALE
        elif err_rate > 0.3:
            state = HealthState.DEGRADED
        else:
            state = HealthState.OK
        return HealthStatus(
            venue_id=self.meta.venue_id, state=state,
            last_success=(datetime.fromtimestamp(self._last_success, tz=UTC)
                          if self._last_success else None),
            error_rate=round(min(err_rate, 1.0), 3),
            consecutive_errors=self._consecutive_errors,
            staleness_s=staleness,
        )

    is_streaming: bool = False  # True for venues with a push (WS) feed

    def stream(self) -> AsyncIterator[RawOddsUpdate] | None:
        return None  # poll-only by default

    def deep_link(self, event_ref: str, market_ref: str | None = None) -> str:
        if self.meta.deep_link_template:
            return self.meta.deep_link_template.format(event_ref=event_ref, market_ref=market_ref or "")
        return self.meta.homepage or ""
