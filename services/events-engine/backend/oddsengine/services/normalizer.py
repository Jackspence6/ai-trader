"""Normalizer: raw venue payloads -> canonical Quotes (spec §4).

Consumes raw_events / raw_markets / raw_odds off the bus, resolves canonical
events via the matcher, maps venue selections to canonical outcomes, fee-adjusts
Polymarket prices, converts PM depth to buffered ZAR capacity, stamps rules groups,
and publishes Quotes to hot state + the bus. Odds snapshots go to Timescale when a
DB is configured.
"""

from __future__ import annotations

from rapidfuzz import fuzz

from ..arbmath import depth_capacity_usd
from ..config import AppConfig
from ..fees import effective_decimal_odds
from ..fx import FxService
from ..matching import CanonicalRegistry, EventMatcher
from ..matching.normalize import normalize_name
from ..models import (
    CanonicalEvent,
    MarketType,
    Outcome,
    Quote,
    RawEvent,
    RawMarket,
    RawOddsUpdate,
    Sport,
    market_key,
)
from ..observability import METRICS, get_logger
from ..rules import rules_group
from ..venues.base import VenueAdapter

log = get_logger("normalizer")

NO_DRAW_SPORTS = {Sport.TENNIS, Sport.BASKETBALL, Sport.MMA, Sport.AMERICAN_FOOTBALL, Sport.ESPORTS}

HINT_MAP = {
    "1": Outcome.HOME, "OT_ONE": Outcome.HOME, "HOME": Outcome.HOME,
    "X": Outcome.DRAW, "OT_CROSS": Outcome.DRAW, "DRAW": Outcome.DRAW,
    "2": Outcome.AWAY, "OT_TWO": Outcome.AWAY, "AWAY": Outcome.AWAY,
    "OVER": Outcome.OVER, "OT_OVER": Outcome.OVER,
    "UNDER": Outcome.UNDER, "OT_UNDER": Outcome.UNDER,
    "YES": Outcome.YES, "OT_YES": Outcome.YES,
    "NO": Outcome.NO, "OT_NO": Outcome.NO,
    # OT_UNTYPED is deliberately absent: Kambi asian-handicap sides are untyped and
    # carry team names, so they must fall through to the name match below.
}


def _similar(a: str, b: str) -> float:
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    return max(fuzz.token_set_ratio(na, nb), fuzz.partial_ratio(na, nb)) / 100.0


def map_selection(mtype: MarketType, name_raw: str, hint: str | None,
                  home: str | None, away: str | None) -> str | None:
    """Venue selection -> canonical outcome label."""
    if hint and hint.upper() in HINT_MAP:
        mapped = HINT_MAP[hint.upper()]
        if str(mapped) in [str(o) for o in _expected(mtype)]:
            return str(mapped)
    name = (name_raw or "").strip().lower()
    if mtype in (MarketType.X12, MarketType.MONEYLINE_2WAY, MarketType.DNB,
                 MarketType.HANDICAP, MarketType.ASIAN_HANDICAP):
        if mtype == MarketType.X12 and name in ("draw", "x", "tie"):
            return str(Outcome.DRAW)
        h = _similar(name_raw, home) if home else 0.0
        a = _similar(name_raw, away) if away else 0.0
        if max(h, a) >= 0.75 and h != a:
            return str(Outcome.HOME) if h > a else str(Outcome.AWAY)
        return None
    if mtype == MarketType.TOTALS:
        if "over" in name:
            return str(Outcome.OVER)
        if "under" in name:
            return str(Outcome.UNDER)
        return None
    if mtype == MarketType.BTTS:
        if name in ("yes", "y"):
            return str(Outcome.BTTS_YES)
        if name in ("no", "n"):
            return str(Outcome.BTTS_NO)
        return None
    if mtype in (MarketType.BINARY_YESNO, MarketType.NEGRISK_MULTI):
        if name in ("yes", "y"):
            return str(Outcome.YES)
        if name in ("no", "n"):
            return str(Outcome.NO)
        return None
    return None


def _expected(mtype: MarketType) -> tuple:
    from ..models import OUTCOME_SETS
    return OUTCOME_SETS.get(mtype, ())


class Normalizer:
    def __init__(self, cfg: AppConfig, registry: CanonicalRegistry, matcher: EventMatcher,
                 adapters: dict[str, VenueAdapter], state, bus, fx: FxService, db=None) -> None:
        self.cfg = cfg
        self.registry = registry
        self.matcher = matcher
        self.adapters = adapters
        self.state = state
        self.bus = bus
        self.fx = fx
        self.db = db
        # (venue_id, event_ref) -> event_id
        self.event_links: dict[tuple[str, str], str] = {}
        # (venue_id, event_ref, market_ref) -> RawMarket
        self.markets: dict[tuple[str, str, str], RawMarket] = {}
        # (venue_id, market_ref, selection_ref) -> canonical outcome
        self.selection_map: dict[tuple[str, str, str], str] = {}
        # market meta: canonical key per raw market
        self.market_keys: dict[tuple[str, str, str], str] = {}
        self.market_types: dict[tuple[str, str, str], MarketType] = {}

    # ------------------------------------------------------------- events
    async def on_raw_event(self, raw: RawEvent) -> CanonicalEvent | None:
        decision = self.matcher.match(raw)
        METRICS.inc(f"normalizer.match.{decision.action}")
        if decision.event is None:
            if decision.action == "review":
                log.info("event_review_queued", venue=raw.venue_id, ref=raw.ref,
                         review_id=decision.review_id, conf=round(decision.confidence, 3))
            return None
        self.event_links[(raw.venue_id, raw.ref)] = decision.event.id
        return decision.event

    # ------------------------------------------------------------ markets
    async def on_raw_market(self, m: RawMarket) -> None:
        key = (m.venue_id, m.event_ref, m.ref)
        self.markets[key] = m
        event_id = self.event_links.get((m.venue_id, m.event_ref))
        event = self.registry.events.get(event_id) if event_id else None
        mtype = m.market_type
        if mtype is None:
            return  # unmapped market type: ignored until the adapter maps it
        qualifier = None
        canonical_type = mtype

        if m.venue_id == "polymarket":
            canonical_type, qualifier = self._pm_market_shape(m, event)
        self.market_types[key] = canonical_type
        self.market_keys[key] = market_key(canonical_type, m.line, qualifier)

        home = event.home if event else None
        away = event.away if event else None
        for sel in m.selections:
            outcome = None
            if m.venue_id == "polymarket":
                outcome = self._pm_selection_outcome(m, sel.name_raw, canonical_type, home, away)
            if outcome is None:
                outcome = map_selection(canonical_type, sel.name_raw, sel.outcome_hint, home, away)
            if outcome is not None:
                self.selection_map[(m.venue_id, m.ref, sel.ref)] = outcome
            else:
                METRICS.inc("normalizer.selection_unmapped")

    def _pm_market_shape(self, m: RawMarket, event: CanonicalEvent | None) -> tuple[MarketType, str | None]:
        """Decide how a PM market projects onto the canonical taxonomy.

        - negRisk member: NEGRISK_MULTI keyed by group (plus the member's own binary
          arb is detected off the same quotes via YES/NO on the member qualifier).
        - Binary team-win market on a no-draw sport with resolvable sides -> MONEYLINE_2WAY
          (joins bookie quotes on the same key).
        - Anything else: BINARY_YESNO scoped by the PM market ref (PM-internal only).
        """
        if m.market_type == MarketType.NEGRISK_MULTI and m.neg_risk_group:
            return MarketType.NEGRISK_MULTI, f"q:{m.neg_risk_group}"
        if event and event.sport in NO_DRAW_SPORTS and event.home and event.away:
            labels = [s.name_raw for s in m.selections]
            sides = {self._side_for_label(lbl, m.market_type_raw or "", event.home, event.away)
                     for lbl in labels}
            if sides == {str(Outcome.HOME), str(Outcome.AWAY)}:
                return MarketType.MONEYLINE_2WAY, None
        return MarketType.BINARY_YESNO, f"q:{m.ref}"

    @staticmethod
    def _side_for_label(label: str, question: str, home: str, away: str) -> str | None:
        """Map a PM selection to a side. Team-name labels match directly; Yes/No labels
        resolve via the question's subject ("Will the Lakers beat the Celtics?" — the
        team after 'Will' is the YES side; both teams appear, so plain similarity on
        the whole question is NOT safe)."""
        import re

        h, a = _similar(label, home), _similar(label, away)
        if max(h, a) >= 0.75 and h != a:
            return str(Outcome.HOME) if h > a else str(Outcome.AWAY)
        low = label.strip().lower()
        if low not in ("yes", "no"):
            return None
        subject = None
        m_ = re.search(r"\bwill\s+(?:the\s+)?(?P<team>.+?)\s+(?:beat|defeat|win|cover)\b",
                       question, re.IGNORECASE)
        if m_:
            subject = m_.group("team")
        if subject:
            sh, sa = _similar(subject, home), _similar(subject, away)
            if max(sh, sa) >= 0.6 and sh != sa:
                side = str(Outcome.HOME) if sh > sa else str(Outcome.AWAY)
                if low == "yes":
                    return side
                return str(Outcome.AWAY) if side == str(Outcome.HOME) else str(Outcome.HOME)
        # Fallback: whole-question similarity, but only with a decisive gap
        qh, qa = _similar(question, home), _similar(question, away)
        if max(qh, qa) >= 0.6 and abs(qh - qa) >= 0.15:
            side = str(Outcome.HOME) if qh > qa else str(Outcome.AWAY)
            if low == "yes":
                return side
            return str(Outcome.AWAY) if side == str(Outcome.HOME) else str(Outcome.HOME)
        return None

    def _pm_selection_outcome(self, m: RawMarket, label: str, canonical_type: MarketType,
                              home: str | None, away: str | None) -> str | None:
        if canonical_type == MarketType.MONEYLINE_2WAY and home and away:
            return self._side_for_label(label, m.market_type_raw or "", home, away)
        if canonical_type == MarketType.NEGRISK_MULTI:
            low = (label or "").lower()
            if low == "yes":
                return f"OUT:{m.ref}"
            if low == "no":
                return f"NOT:{m.ref}"
            return f"OUT:{m.ref}"
        return None

    # --------------------------------------------------------------- odds
    async def on_raw_odds(self, upd: RawOddsUpdate) -> Quote | None:
        mkey_id = (upd.venue_id, upd.event_ref, upd.market_ref)
        event_id = self.event_links.get((upd.venue_id, upd.event_ref))
        canonical_key = self.market_keys.get(mkey_id)
        if event_id is None or canonical_key is None:
            METRICS.inc("normalizer.odds_unlinked")
            return None
        outcome = self.selection_map.get((upd.venue_id, upd.market_ref, upd.selection_ref))
        if outcome is None:
            METRICS.inc("normalizer.odds_unmapped")
            return None

        adapter = self.adapters.get(upd.venue_id)
        event = self.registry.events.get(event_id)
        mtype = self.market_types.get(mkey_id, MarketType.BINARY_YESNO)
        rgroup = "UNVERIFIED"
        if adapter is not None and event is not None:
            rgroup = rules_group(adapter.rules_profile, event.sport, mtype)

        is_pm = upd.pm_buy_price is not None
        if is_pm:
            if upd.pm_buy_price is None or not (0.0 < upd.pm_buy_price < 1.0):
                METRICS.inc("normalizer.pm_bad_price")
                return None
            fee = upd.pm_fee_rate if upd.pm_fee_rate is not None else 0.05
            odds_eff = effective_decimal_odds(upd.pm_buy_price, fee)
            cap_usd = depth_capacity_usd(upd.depth or [], upd.pm_buy_price, fee,
                                         self.cfg.polymarket.slippage_bps)
            max_stake_zar = self.fx.usd_to_zar(min(cap_usd, self.cfg.engine.max_usd_exposure))
        else:
            if upd.decimal_odds is None or upd.decimal_odds <= 1.0:
                METRICS.inc("normalizer.bad_odds")
                return None
            odds_eff = upd.decimal_odds
            max_stake_zar = upd.max_stake

        raw_market = self.markets.get(mkey_id)
        label = ""
        if raw_market:
            for sel in raw_market.selections:
                if sel.ref == upd.selection_ref:
                    label = sel.name_raw
                    break

        quote = Quote(
            venue_id=upd.venue_id, event_id=event_id, market_key=canonical_key, outcome=outcome,
            odds_eff=odds_eff, raw_price=upd.pm_buy_price, fee_rate=upd.pm_fee_rate,
            is_pm=is_pm, token_id=upd.selection_ref if is_pm else None,
            mirror_of=(upd.extra or {}).get("complement_token"),
            line=upd.line, status=upd.status, rules_group=rgroup,
            max_stake_zar=max_stake_zar, depth=upd.depth,
            selection_label=label or outcome,
            deep_link=adapter.deep_link(upd.event_ref, upd.market_ref) if adapter else "",
            neg_risk_group=raw_market.neg_risk_group if raw_market else None,
            neg_risk_complete=raw_market.neg_risk_complete if raw_market else False,
            neg_risk_size=raw_market.neg_risk_size if raw_market else None,
            ts_source=upd.ts_source, ts_ingest=upd.ts_ingest,
        )
        await self.state.upsert_quote(quote)
        await self.bus.publish("quotes", quote.model_dump(mode="json"))
        if self.db is not None:
            await self.db.record_snapshot(quote)
        METRICS.inc("normalizer.quotes_published")
        return quote

    # ---------------------------------------------------------- ingestion
    async def run(self) -> None:
        """Consume the three raw topics forever (Compose deployment entrypoint)."""
        import asyncio

        async def _events() -> None:
            async for payload in self.bus.subscribe("raw_events"):
                await self.on_raw_event(RawEvent.model_validate(payload))

        async def _markets() -> None:
            async for payload in self.bus.subscribe("raw_markets"):
                await self.on_raw_market(RawMarket.model_validate(payload))

        async def _odds() -> None:
            async for payload in self.bus.subscribe("raw_odds"):
                await self.on_raw_odds(RawOddsUpdate.model_validate(payload))

        await asyncio.gather(_events(), _markets(), _odds())
