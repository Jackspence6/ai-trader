"""Betway SA adapter — Betradar (`emop`) feed behind Betway's own proxy (spec §3.2).

DISCOVERED 2026-08-25 against the live book from a South African IP
(see discovery.md for the capture record):

    GET https://www.betway.co.za/sportsapi/br/v1/BetBook/Highlights/
        ?countryCode=ZA&sportId={sport}&Skip=0&Take={n}&cultureCode=en-US
        &isEsport=false&boostedOnly=false
        &marketTypes=...&marketTypes=...        (repeated; the filter is REQUIRED)

`marketTypes` is not optional — omit it and the response has no `events` key at
all. The accepted names per sport come from Betway's own market-header config:

    GET https://config.betwayafrica.com/cron/sports-book/market-header-config/synapse/ZA

One request returns the whole board as four flat, joinable arrays:

    events[]    eventId, name, homeTeam, awayTeam, league, region,
                expectedStartEpoch (unix seconds), isLive, isOutright, isFinished
    markets[]   marketId, eventId, marketTypeCName, name, handicap (plain decimal),
                isActive / isSuspended / shouldDisplay / isSquashedParent,
                additionalInfo.ProviderMarketGroups (a JSON *string*)
    outcomes[]  outcomeId, marketId, name, isTradingActive, shouldDisplay
    prices[]    outcomeId, priceDecimal (plain decimal), numerator, denominator

No auth: the endpoint answers identically with cookies omitted. Odds are plain
decimals here, not the milli integers Kambi uses.

--------------------------------------------------------------------------
The safety gate
--------------------------------------------------------------------------
Betradar tags every market with its settlement scope in
`ProviderMarketGroups` — `["all", "score", "regular_play"]` for a full-match
market, and a period tag for the halves. So the gate is two-part: the market's
`(sport, marketTypeCName)` must be on the allowlist, *and* the market must
declare `regular_play`. A market that stops declaring it stops being priced,
without anyone having to notice a new label.

Totals need one more step, and it is the step that bites. A totals ladder is
published as a single "squashed parent" market (`isSquashedParent: true`,
`handicap: 0`) that carries *every* line's outcomes — 22 of them on one soccer
event, spanning Over/Under 0.5 through 5.5. The per-line child markets are listed
too, but they are empty shells with no outcomes attached. So:

  * skipping the squashed parent drops totals entirely, and
  * pricing the parent as one market puts eleven different lines in one book,
    which reads as a wild arb between Over 0.5 and Under 5.5.

Each outcome carries its own `handicap` and an `originalMarketId` naming its line
(`...total_2.5~`). The adapter splits the parent on that, emitting one canonical
market per line. Markets with no outcomes are dropped rather than published empty.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ...compat import UTC
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
from ...rules import VenueRulesProfile
from ..base import VenueMeta
from ..skeleton import SkeletonBookieAdapter

REGULAR_PLAY = "regular_play"

# Betway sportId -> canonical sport. Only sports whose markets are on the
# allowlist below are swept.
BETWAY_SPORT_IDS: dict[Sport, str] = {
    Sport.SOCCER: "soccer",
    Sport.TENNIS: "tennis",
    Sport.RUGBY: "rugby-union",
}
SPORT_BY_ID = {v: k for k, v in BETWAY_SPORT_IDS.items()}

# The `marketTypes` filter values that must be sent per sport, taken verbatim from
# Betway's market-header config. Sending a name the sport does not use is harmless;
# omitting the parameter entirely breaks the response.
BETWAY_MARKET_FILTERS: dict[Sport, tuple[str, ...]] = {
    Sport.SOCCER: ("[Win/Draw/Win]", "Total Goals", "[Both Teams To Score]"),
    Sport.TENNIS: ("[Match Winner]", "Total Games"),
    Sport.RUGBY: ("[Win/Draw/Win]",),
}


@dataclass(frozen=True)
class BetwayRule:
    market_type: MarketType
    has_line: bool


# (sport, marketTypeCName) -> canonical market. Every row was observed live.
BETWAY_ALLOWLIST: dict[tuple[Sport, str], BetwayRule] = {
    (Sport.SOCCER, "win-draw-win"): BetwayRule(MarketType.X12, False),
    (Sport.SOCCER, "Total"): BetwayRule(MarketType.TOTALS, True),
    (Sport.SOCCER, "both-teams-to-score"): BetwayRule(MarketType.BTTS, False),
    (Sport.TENNIS, "to-win"): BetwayRule(MarketType.MONEYLINE_2WAY, False),
    (Sport.TENNIS, "handicap-games-over"): BetwayRule(MarketType.TOTALS, True),
    # Rugby is a genuine three-way here — Betway prices the draw, unlike Kambi's
    # two-way "Regular Time". They are different markets and must not be paired.
    (Sport.RUGBY, "win-draw-win"): BetwayRule(MarketType.X12, False),
}

# Outcome labels Betradar emits verbatim; anything else falls through to the
# normalizer's name match against the event's teams.
OUTCOME_HINTS = {"draw": "X", "over": "OVER", "under": "UNDER", "yes": "YES", "no": "NO"}


def _groups(market: dict[str, Any]) -> list[str]:
    """ProviderMarketGroups arrives as a JSON string inside additionalInfo."""
    raw = (market.get("additionalInfo") or {}).get("ProviderMarketGroups")
    if isinstance(raw, list):
        return [str(g) for g in raw]
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return []
        return [str(g) for g in parsed] if isinstance(parsed, list) else []
    return []


def classify_market(market: dict[str, Any], sport: Sport) -> BetwayRule | None:
    """The allowlist gate. Returns the rule, or None to refuse the market."""
    if REGULAR_PLAY not in _groups(market):
        return None
    cname = market.get("marketTypeCName")
    if not cname:
        return None
    return BETWAY_ALLOWLIST.get((sport, str(cname)))


def split_by_line(market: dict[str, Any], outcomes: list[dict[str, Any]],
                  rule: BetwayRule) -> list[tuple[str, float | None, list[dict[str, Any]]]]:
    """One published market -> one canonical market per betting line.

    Lineless markets (1X2, BTTS) pass straight through. A totals ladder arrives as
    one squashed parent holding every line's outcomes, so it is split on each
    outcome's `originalMarketId` — the id of the per-line market it belongs to.
    """
    if not outcomes:
        return []
    if not rule.has_line:
        return [(str(market.get("marketId")), None, outcomes)]

    groups: dict[str, list[dict[str, Any]]] = {}
    for oc in outcomes:
        ref = str(oc.get("originalMarketId") or market.get("marketId"))
        groups.setdefault(ref, []).append(oc)

    split: list[tuple[str, float | None, list[dict[str, Any]]]] = []
    for ref, ocs in groups.items():
        lines = {float(o["handicap"]) for o in ocs if o.get("handicap") is not None}
        if len(lines) != 1:
            continue          # a line we cannot name is a line we do not price
        split.append((ref, lines.pop(), ocs))
    return split


def market_status(market: dict[str, Any]) -> MarketStatus:
    if market.get("isSuspended") or not market.get("isActive", True):
        return MarketStatus.SUSPENDED
    return MarketStatus.ACTIVE


class BetwaySAAdapter(SkeletonBookieAdapter):
    VENUE_ID = "betway_sa"

    def __init__(self, endpoints: dict[str, Any] | None = None, *, enabled: bool = False,
                 softness: float = 0.45, max_stake_default: float = 20000.0) -> None:
        meta = VenueMeta(
            venue_id=self.VENUE_ID, name="Betway SA", kind=VenueKind.BOOKIE,
            softness=softness, min_interval_s=20.0, max_stake_default=max_stake_default,
            homepage="https://www.betway.co.za",
            deep_link_template="https://www.betway.co.za/sport/{event_ref}",
            enabled=enabled,
        )
        profile = VenueRulesProfile(venue_id=self.VENUE_ID)
        # Every mapped market declares Betradar's `regular_play` scope, which is
        # exactly what soccer_duration=REG_90 means. Tennis retirement is a T&Cs
        # question the feed does not answer, so it stays UNVERIFIED.
        profile.soccer_duration = "REG_90"
        super().__init__(meta, profile, dict(endpoints or {}))

    # --------------------------------------------------------------- config
    @property
    def configured(self) -> bool:
        return bool(self.endpoints.get("highlights_url"))

    def _url(self, sport: Sport, *, take: int, skip: int = 0) -> tuple[str, list[tuple[str, str]]]:
        base = str(self.endpoints["highlights_url"])
        params: list[tuple[str, str]] = [
            ("countryCode", str(self.endpoints.get("country_code", "ZA"))),
            ("sportId", BETWAY_SPORT_IDS[sport]),
            ("Skip", str(skip)),
            ("Take", str(take)),
            ("cultureCode", str(self.endpoints.get("culture_code", "en-US"))),
            ("isEsport", "false"),
            ("boostedOnly", "false"),
        ]
        params += [("marketTypes", m) for m in BETWAY_MARKET_FILTERS[sport]]
        return base, params

    # -------------------------------------------------------------- parsing
    def _sport_of(self, payload: Any) -> Sport:
        for ev in (payload or {}).get("events", []) or []:
            sid = str(ev.get("sportId") or "")
            if sid in SPORT_BY_ID:
                return SPORT_BY_ID[sid]
        return Sport.OTHER

    def parse_events(self, payload: Any) -> list[RawEvent]:
        out: list[RawEvent] = []
        for ev in (payload or {}).get("events", []) or []:
            if ev.get("eventId") is None or ev.get("isOutright"):
                continue
            start = None
            epoch = ev.get("expectedStartEpoch")
            if epoch:
                try:
                    start = datetime.fromtimestamp(float(epoch), tz=UTC)
                except (TypeError, ValueError, OSError):
                    start = None
            status = MarketStatus.ACTIVE
            if ev.get("isFinished"):
                status = MarketStatus.CLOSED
            out.append(RawEvent(
                venue_id=self.meta.venue_id,
                ref=str(ev["eventId"]),
                sport=SPORT_BY_ID.get(str(ev.get("sportId") or ""), Sport.OTHER),
                league_raw=ev.get("league"),
                home_raw=ev.get("homeTeam"),
                away_raw=ev.get("awayTeam"),
                title_raw=ev.get("name"),
                start_time=start,
                status=status,
                extra={"region": ev.get("region"), "is_live": bool(ev.get("isLive"))},
            ))
        return out

    def parse_markets(self, payload: Any, event_ref: str | None = None) -> list[RawMarket]:
        sport = self._sport_of(payload)
        outcomes_by_market = self._outcomes_by_market(payload)
        out: list[RawMarket] = []
        for mk in (payload or {}).get("markets", []) or []:
            if mk.get("marketId") is None or mk.get("eventId") is None:
                continue
            ref = str(mk["eventId"])
            if event_ref is not None and ref != str(event_ref):
                continue
            outcomes = outcomes_by_market.get(str(mk["marketId"]), [])
            if not outcomes:
                continue          # empty per-line shell of a squashed ladder
            rule = classify_market(mk, sport)
            groups = (split_by_line(mk, outcomes, rule) if rule
                      else [(str(mk["marketId"]), None, outcomes)])
            for market_ref, line, ocs in groups:
                out.append(RawMarket(
                    venue_id=self.meta.venue_id,
                    event_ref=ref,
                    ref=market_ref,
                    market_type=rule.market_type if rule else None,
                    market_type_raw=str(mk.get("name") or mk.get("marketTypeCName") or ""),
                    line=line,
                    selections=[
                        RawSelection(
                            ref=str(oc["outcomeId"]),
                            name_raw=str(oc.get("name") or oc.get("displayName") or "").strip(),
                            outcome_hint=OUTCOME_HINTS.get(
                                str(oc.get("name") or "").strip().lower(), ""),
                        )
                        for oc in ocs if oc.get("outcomeId") is not None
                    ],
                    status=market_status(mk),
                    extra={
                        "cname": mk.get("marketTypeCName"),
                        "groups": _groups(mk),
                        "published_market_id": str(mk["marketId"]),
                        "squashed_parent": bool(mk.get("isSquashedParent")),
                        "mapped": rule is not None,
                    },
                ))
        return out

    def parse_odds(self, payload: Any, event_ref: str | None = None) -> list[RawOddsUpdate]:
        sport = self._sport_of(payload)
        price_by_outcome = {
            str(p.get("outcomeId")): p for p in (payload or {}).get("prices", []) or []
        }
        outcomes_by_market = self._outcomes_by_market(payload)

        out: list[RawOddsUpdate] = []
        for mk in (payload or {}).get("markets", []) or []:
            rule = classify_market(mk, sport)
            if rule is None:
                continue
            ref = str(mk.get("eventId"))
            if event_ref is not None and ref != str(event_ref):
                continue
            outcomes = outcomes_by_market.get(str(mk.get("marketId")), [])
            status = market_status(mk)
            for market_ref, line, ocs in split_by_line(mk, outcomes, rule):
                for oc in ocs:
                    if not oc.get("isTradingActive", True) or not oc.get("shouldDisplay", True):
                        continue
                    price = price_by_outcome.get(str(oc.get("outcomeId")))
                    if not price:
                        continue
                    try:
                        odds = float(price.get("priceDecimal"))
                    except (TypeError, ValueError):
                        continue
                    if odds <= 1.0:
                        continue
                    out.append(RawOddsUpdate(
                        venue_id=self.meta.venue_id,
                        event_ref=ref,
                        market_ref=market_ref,
                        selection_ref=str(oc["outcomeId"]),
                        decimal_odds=odds,
                        line=line,
                        status=status,
                        max_stake=self.meta.max_stake_default,
                        ts_source=utcnow(),
                        ts_ingest=utcnow(),
                        extra={"market_type": str(rule.market_type)},
                    ))
        return out

    @staticmethod
    def _outcomes_by_market(payload: Any) -> dict[str, list[dict[str, Any]]]:
        by_market: dict[str, list[dict[str, Any]]] = {}
        for oc in (payload or {}).get("outcomes", []) or []:
            by_market.setdefault(str(oc.get("marketId")), []).append(oc)
        return by_market

    # ------------------------------------------------------------ interface
    async def discover_events(self, sport: str) -> list[RawEvent]:
        self._require_config()
        payload = await self._board(sport)
        self._last_board[sport] = payload
        return self.parse_events(payload)

    _last_board: dict[str, Any] = {}

    async def _board(self, sport: str) -> Any:
        try:
            canonical = Sport(sport)
        except ValueError as exc:
            raise ValueError(f"betway_sa: unsupported sport '{sport}'") from exc
        if canonical not in BETWAY_SPORT_IDS:
            raise ValueError(f"betway_sa: no market allowlist for {canonical}")
        take = int(self.endpoints.get("take", 100))
        url, params = self._url(canonical, take=take)
        await self.pace()
        client = await self.client()
        try:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            self.note_success()
            return resp.json()
        except Exception:
            self.note_error()
            raise

    async def fetch_markets(self, event_ref: str) -> list[RawMarket]:
        self._require_config()
        for payload in self._last_board.values():
            markets = self.parse_markets(payload, event_ref)
            if markets:
                return markets
        return []

    async def fetch_odds(self, event_ref: str) -> list[RawOddsUpdate]:
        """One board request covers every event, so odds are served from the last
        sweep rather than re-fetching per event."""
        self._require_config()
        for payload in self._last_board.values():
            updates = self.parse_odds(payload, event_ref)
            if updates:
                return updates
        return []
