"""Polymarket venue adapter: Gamma discovery + CLOB reads + WS market channel.

Read-only in Phase 1. Geo note (spec §3.3): Polymarket is geoblocked from US IPs —
run ingestion from an SA-resident (or other non-US) egress; SA IPs are fine.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime

from dateutil import parser as dtparser

from ...config import PolymarketConfig
from ...fees import fee_rate_for_category
from ...models import (
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
from ...observability import get_logger
from ...rules import default_profiles
from ..base import BaseAdapter, VenueMeta
from .clob import ClobClient
from .gamma import GammaClient
from .parsing import ParsedBook, ParsedMarket
from .ws import MarketChannelConsumer

log = get_logger("polymarket.adapter")

SPORT_BY_TAG = {
    "nba": Sport.BASKETBALL, "basketball": Sport.BASKETBALL,
    "nfl": Sport.AMERICAN_FOOTBALL, "american-football": Sport.AMERICAN_FOOTBALL,
    "soccer": Sport.SOCCER, "epl": Sport.SOCCER, "football": Sport.SOCCER,
    "la-liga": Sport.SOCCER, "champions-league": Sport.SOCCER,
    "tennis": Sport.TENNIS, "atp": Sport.TENNIS, "wta": Sport.TENNIS,
    "mma": Sport.MMA, "ufc": Sport.MMA,
    "cricket": Sport.CRICKET, "rugby": Sport.RUGBY,
    "esports": Sport.ESPORTS,
}


@dataclass
class TrackedToken:
    token_id: str
    event_ref: str
    market_ref: str
    outcome_label: str
    fee_rate: float
    neg_risk_group: str | None
    complement_token: str | None    # the other token of a binary pair (mirror dedupe)


class PolymarketAdapter(BaseAdapter):
    def __init__(self, cfg: PolymarketConfig, *, softness: float = 0.9) -> None:
        meta = VenueMeta(
            venue_id="polymarket", name="Polymarket", kind=VenueKind.PREDICTION_MARKET,
            currency="USD", softness=1.0 - softness,  # sharp venue -> low softness score
            min_interval_s=2.0, max_stake_default=None,
            deep_link_template="https://polymarket.com/event/{event_ref}",
            homepage="https://polymarket.com",
        )
        super().__init__(meta, default_profiles()["polymarket"])
        self.cfg = cfg
        self.gamma = GammaClient(cfg.gamma_url)
        self.clob = ClobClient(cfg.clob_url)
        self.ws = MarketChannelConsumer(cfg.ws_url)
        self.tracked: dict[str, TrackedToken] = {}          # token_id -> mapping
        self._markets: dict[str, ParsedMarket] = {}         # condition_id -> parsed
        self._events: dict[str, RawEvent] = {}              # event_ref -> RawEvent

    # ---------------------------------------------------------- discovery
    @staticmethod
    def _sport_for(category: str | None) -> Sport:
        return SPORT_BY_TAG.get((category or "").lower(), Sport.OTHER)

    @staticmethod
    def _parse_dt(value: str | None) -> datetime | None:
        if not value:
            return None
        try:
            return dtparser.isoparse(value)
        except (ValueError, TypeError):
            return None

    async def discover_events(self, sport: str) -> list[RawEvent]:
        await self.pace()
        try:
            markets = await self.gamma.sports_markets(self.cfg.sports_tags)
            self.note_success()
        except Exception as exc:  # noqa: BLE001
            self.note_error()
            log.warning("gamma_discovery_failed", error=str(exc))
            return []

        events: dict[str, RawEvent] = {}
        for pm in markets:
            self._markets[pm.condition_id] = pm
            ref = pm.event_id or pm.condition_id
            sp = self._sport_for(pm.category)
            if sport not in ("*", sp.value):
                continue
            start = self._parse_dt(pm.game_start_time) or self._parse_dt(pm.end_date)
            ev = RawEvent(
                venue_id=self.meta.venue_id, ref=ref, sport=sp,
                title_raw=pm.event_title or pm.question,
                start_time=start,
                extra={"date_bracketed": True, "slug": pm.slug},
            )
            events[ref] = ev
        self._events.update(events)
        return list(events.values())

    async def fetch_markets(self, event_ref: str) -> list[RawMarket]:
        out: list[RawMarket] = []
        for pm in self._markets.values():
            if (pm.event_id or pm.condition_id) != event_ref:
                continue
            fallback = fee_rate_for_category(pm.category)
            fee = fallback
            if self.cfg.read_fee_rate_live and pm.token_ids:
                fee = await self.clob.fee_rate(pm.token_ids[0], fallback)
            neg_group = pm.event_id if pm.neg_risk else None
            n = min(len(pm.token_ids), len(pm.outcomes)) or len(pm.token_ids)
            selections = []
            for i in range(n):
                label = pm.outcomes[i] if i < len(pm.outcomes) else f"outcome_{i}"
                token = pm.token_ids[i]
                complement = pm.token_ids[1 - i] if len(pm.token_ids) == 2 else None
                selections.append(RawSelection(ref=token, name_raw=label, outcome_hint=label))
                self.tracked[token] = TrackedToken(
                    token_id=token, event_ref=event_ref, market_ref=pm.condition_id,
                    outcome_label=label, fee_rate=fee, neg_risk_group=neg_group,
                    complement_token=complement,
                )
            out.append(RawMarket(
                venue_id=self.meta.venue_id, event_ref=event_ref, ref=pm.condition_id,
                market_type=MarketType.NEGRISK_MULTI if pm.neg_risk else MarketType.BINARY_YESNO,
                market_type_raw=pm.question,
                selections=selections,
                neg_risk_group=neg_group,
                neg_risk_complete=False,  # engine may only run full-set math once adapter confirms
                extra={"slug": pm.slug, "category": pm.category, "fee_rate": fee},
            ))
        # Mark negRisk groups complete when every group market is tracked with >= 2 outcomes total
        by_group: dict[str, list[RawMarket]] = {}
        for m in out:
            if m.neg_risk_group:
                by_group.setdefault(m.neg_risk_group, []).append(m)
        for group_markets in by_group.values():
            complete = len(group_markets) >= 2
            for m in group_markets:
                m.neg_risk_complete = complete
                m.neg_risk_size = len(group_markets)
        self.ws.set_tokens(set(self.tracked.keys()))
        return out

    # -------------------------------------------------------------- odds
    def _book_to_update(self, book: ParsedBook) -> RawOddsUpdate | None:
        tt = self.tracked.get(book.token_id)
        if tt is None:
            return None
        best_ask = book.best_ask
        status = MarketStatus.ACTIVE if best_ask is not None else MarketStatus.SUSPENDED
        return RawOddsUpdate(
            venue_id=self.meta.venue_id, event_ref=tt.event_ref, market_ref=tt.market_ref,
            selection_ref=tt.token_id,
            pm_buy_price=best_ask, pm_sell_price=book.best_bid, pm_fee_rate=tt.fee_rate,
            status=status, depth=book.asks or None,
            ts_source=utcnow(), ts_ingest=utcnow(),
            extra={"neg_risk_group": tt.neg_risk_group, "complement_token": tt.complement_token,
                   "outcome_label": tt.outcome_label},
        )

    async def fetch_odds(self, event_ref: str) -> list[RawOddsUpdate]:
        """REST snapshot fallback / backfill; the live path is stream()."""
        out: list[RawOddsUpdate] = []
        for token_id, tt in list(self.tracked.items()):
            if tt.event_ref != event_ref:
                continue
            await self.pace()
            book = await self.clob.book(token_id)
            if book is None:
                self.note_error()
                continue
            self.note_success()
            upd = self._book_to_update(book)
            if upd:
                out.append(upd)
        return out

    is_streaming = True

    def stream(self) -> AsyncIterator[RawOddsUpdate] | None:
        async def _gen() -> AsyncIterator[RawOddsUpdate]:
            async for book in self.ws.books():
                self.note_success()
                upd = self._book_to_update(book)
                if upd:
                    yield upd
        return _gen()

    def deep_link(self, event_ref: str, market_ref: str | None = None) -> str:
        ev = self._events.get(event_ref)
        slug = (ev.extra.get("slug") if ev else None) or event_ref
        return f"https://polymarket.com/event/{slug}"

    async def close(self) -> None:
        await self.gamma.close()
        await self.clob.close()
