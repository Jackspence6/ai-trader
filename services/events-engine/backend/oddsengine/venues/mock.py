"""Deterministic mock venues for the demo, replay tests and load tests.

A MockVenue is scripted: it holds a fixture list and a timeline of odds updates
keyed by tick number. The demo advances ticks manually — no wall-clock sleeps —
so end-to-end behavior is reproducible and assertable.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime

from ..models import (
    MarketStatus,
    MarketType,
    RawEvent,
    RawMarket,
    RawOddsUpdate,
    RawSelection,
    Sport,
    VenueKind,
    utcnow,
)
from ..rules import VenueRulesProfile
from .base import BaseAdapter, VenueMeta


@dataclass
class ScriptedUpdate:
    tick: int
    event_ref: str
    market_ref: str
    selection_ref: str
    decimal_odds: float | None = None
    pm_buy_price: float | None = None
    pm_fee_rate: float | None = None
    status: MarketStatus = MarketStatus.ACTIVE
    max_stake: float | None = None
    depth_shares: float | None = None   # simple one-level depth for PM mocks


@dataclass
class MockFixture:
    ref: str
    sport: Sport
    league: str
    home: str
    away: str
    start_time: datetime
    markets: list[RawMarket] = field(default_factory=list)


class MockVenue(BaseAdapter):
    def __init__(self, venue_id: str, name: str, *, kind: VenueKind = VenueKind.BOOKIE,
                 softness: float = 0.6, rules: VenueRulesProfile | None = None,
                 max_stake_default: float = 20000.0) -> None:
        meta = VenueMeta(
            venue_id=venue_id, name=name, kind=kind, softness=softness, min_interval_s=0.0,
            max_stake_default=max_stake_default,
            deep_link_template=f"https://mock.example/{venue_id}/event/{{event_ref}}",
            homepage=f"https://mock.example/{venue_id}",
        )
        super().__init__(meta, rules or VenueRulesProfile(venue_id=venue_id))
        self.fixtures: dict[str, MockFixture] = {}
        self.script: list[ScriptedUpdate] = []
        self.tick = -1

    # ---------------------------------------------------------- scripting
    def add_fixture(self, fx: MockFixture) -> None:
        self.fixtures[fx.ref] = fx

    def add_market(self, event_ref: str, market_ref: str, market_type: MarketType,
                   selections: list[tuple[str, str]], line: float | None = None) -> None:
        fx = self.fixtures[event_ref]
        fx.markets.append(RawMarket(
            venue_id=self.meta.venue_id, event_ref=event_ref, ref=market_ref,
            market_type=market_type, line=line,
            selections=[RawSelection(ref=r, name_raw=n) for r, n in selections],
        ))

    def script_update(self, upd: ScriptedUpdate) -> None:
        self.script.append(upd)

    def updates_for_tick(self, tick: int) -> list[RawOddsUpdate]:
        out = []
        for u in self.script:
            if u.tick != tick:
                continue
            depth = None
            if u.depth_shares is not None and u.pm_buy_price is not None:
                from ..models import BookLevel
                depth = [BookLevel(price=u.pm_buy_price, size=u.depth_shares)]
            out.append(RawOddsUpdate(
                venue_id=self.meta.venue_id, event_ref=u.event_ref, market_ref=u.market_ref,
                selection_ref=u.selection_ref, decimal_odds=u.decimal_odds,
                pm_buy_price=u.pm_buy_price, pm_fee_rate=u.pm_fee_rate, status=u.status,
                max_stake=u.max_stake if u.max_stake is not None else self.meta.max_stake_default,
                depth=depth, ts_source=utcnow(), ts_ingest=utcnow(),
            ))
        self.note_success()
        return out

    # ---------------------------------------------------------- interface
    async def discover_events(self, sport: str) -> list[RawEvent]:
        self.note_success()
        return [
            RawEvent(
                venue_id=self.meta.venue_id, ref=fx.ref, sport=fx.sport, league_raw=fx.league,
                home_raw=fx.home, away_raw=fx.away, start_time=fx.start_time,
            )
            for fx in self.fixtures.values()
            if sport in ("*", fx.sport.value)
        ]

    async def fetch_markets(self, event_ref: str) -> list[RawMarket]:
        self.note_success()
        return list(self.fixtures[event_ref].markets)

    async def fetch_odds(self, event_ref: str) -> list[RawOddsUpdate]:
        return [u for u in self.updates_for_tick(self.tick) if u.event_ref == event_ref]

    def stream(self) -> AsyncIterator[RawOddsUpdate] | None:
        return None
