"""Kambi offering-API adapter (spec §3.2 / §4.6).

DISCOVERED 2026-08-25 against the live Sunbet book from a South African IP
(see venues/sunbet/discovery.md for the capture record):

    base      https://eu.offering-api.kambicdn.com
    operator  siwc
    listView  {base}/offering/v2018/{op}/listView/{path}.json?channel_id=1&client_id=200
              &lang=en_ZA&market=ZA&useCombined=true&useCombinedLive=true
    betoffer  {base}/offering/v2018/{op}/betoffer/event/{event_id}.json?...same auth params

`path` is a Kambi term path: a sport ("football", "tennis") or a league
("football/south_africa/psl"). Both return the same envelope.

Wire formats, confirmed on live payloads:
  * odds  — milli-decimal integers: 1960 -> 1.96, 3300 -> 3.30
  * lines — milli, signed:          2500 -> 2.5, -500 -> -0.5

--------------------------------------------------------------------------
Why market mapping here is an allowlist and not a keyword match
--------------------------------------------------------------------------
A single Kambi event carries ~110 bet offers. Mapping on betOfferType or on a
substring of the label produces silent, money-losing collisions. All of these are
real offers observed on one PSL fixture:

    betOfferType 6 "Over/Under"  criterion "Total Goals"                lifetime FULL_TIME  occ GOALS
    betOfferType 6 "Over/Under"  criterion "Total Corners"              lifetime FULL_TIME  occ (null)
    betOfferType 6 "Over/Under"  criterion "Total Goals by Chippa Utd"  lifetime FULL_TIME  occ (null)
    betOfferType 6 "Over/Under"  criterion "Total Goals - 1st Half"     lifetime (null)     occ GOALS

Type alone collapses corners, team totals and half totals onto the match total.
`lifetime == FULL_TIME` alone still lets corners and team totals through. And a
blanket FULL_TIME requirement would *reject* the genuine full-match
"Both Teams To Score", which carries a null lifetime.

So a market is mapped only when the exact triple
(sport, betOfferType.id, criterion.englishLabel) is on the allowlist *and* the
offer's lifetime, occurrenceType and outcome-type set match the recorded variant.
Anything else gets market_type=None and is carried as an unmapped raw market —
visible, never arbitraged. Adding a market means observing it and adding a row.

The label also carries settlement semantics that the rules matrix (spec §4.6)
needs: Kambi lists rugby "Regular Time" and "Including Overtime" as separate
offers on the same event, and basketball only as "- Including Overtime". The
allowlist records that as `rules_axis`, and only offers whose settlement basis is
stated in the label are mapped at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..compat import UTC
from ..models import (
    MarketStatus,
    MarketType,
    RawEvent,
    RawMarket,
    RawOddsUpdate,
    RawSelection,
    Sport,
    utcnow,
)
from ..rules import VenueRulesProfile
from .base import VenueMeta
from .skeleton import SkeletonBookieAdapter

MILLI = 1000.0

KAMBI_SPORT_MAP: dict[str, Sport] = {
    "FOOTBALL": Sport.SOCCER,
    "TENNIS": Sport.TENNIS,
    "BASKETBALL": Sport.BASKETBALL,
    "RUGBY_UNION": Sport.RUGBY,
    "RUGBY_LEAGUE": Sport.RUGBY,
    "CRICKET": Sport.CRICKET,
    "AMERICAN_FOOTBALL": Sport.AMERICAN_FOOTBALL,
    "MIXED_MARTIAL_ARTS": Sport.MMA,
    "UFC": Sport.MMA,
    "COUNTER_STRIKE": Sport.ESPORTS,
    "DOTA_2": Sport.ESPORTS,
    "LEAGUE_OF_LEGENDS": Sport.ESPORTS,
    "VALORANT": Sport.ESPORTS,
}

# Term paths whose listView is fetched for a canonical sport. Sport-level paths
# return the whole tree (263 football events, 252 tennis on the live book).
KAMBI_SPORT_PATHS: dict[Sport, tuple[str, ...]] = {
    Sport.SOCCER: ("football",),
    Sport.TENNIS: ("tennis",),
    Sport.BASKETBALL: ("basketball",),
    Sport.RUGBY: ("rugby_union", "rugby_league"),
    Sport.CRICKET: ("cricket",),
    Sport.AMERICAN_FOOTBALL: ("american_football",),
    Sport.ESPORTS: ("esports",),
}

# Outcome-type sets, named for readability in the allowlist below.
T_1X2 = frozenset({"OT_ONE", "OT_CROSS", "OT_TWO"})
T_12 = frozenset({"OT_ONE", "OT_TWO"})
T_OU = frozenset({"OT_OVER", "OT_UNDER"})
T_YN = frozenset({"OT_YES", "OT_NO"})
T_UNTYPED = frozenset({"OT_UNTYPED"})


@dataclass(frozen=True)
class KambiRule:
    """One accepted (market, settlement-basis) variant of a bet offer."""

    market_type: MarketType
    outcome_types: frozenset[str]
    lifetime: str | None          # required criterion.lifetime; None means must be absent
    occurrence: str | None        # required criterion.occurrenceType; None means must be absent
    rules_axis: tuple[str, str] | None = None   # (axis name, value) this label proves


# (sport, betOfferType.id, criterion.englishLabel.casefold()) -> accepted variants.
# Every row below was observed on the live Sunbet offering; nothing here is inferred.
KAMBI_ALLOWLIST: dict[tuple[Sport, int, str], tuple[KambiRule, ...]] = {
    # ---- soccer -------------------------------------------------------------
    (Sport.SOCCER, 2, "full time"): (
        KambiRule(MarketType.X12, T_1X2, "FULL_TIME", "GOALS", ("soccer_duration", "REG_90")),
    ),
    (Sport.SOCCER, 2, "draw no bet"): (
        KambiRule(MarketType.DNB, T_12, "FULL_TIME", "GOALS", ("soccer_duration", "REG_90")),
    ),
    (Sport.SOCCER, 6, "total goals"): (
        KambiRule(MarketType.TOTALS, T_OU, "FULL_TIME", "GOALS"),
    ),
    (Sport.SOCCER, 1, "handicap"): (
        KambiRule(MarketType.HANDICAP, T_12, "FULL_TIME", "GOALS"),
    ),
    (Sport.SOCCER, 7, "asian handicap"): (
        KambiRule(MarketType.ASIAN_HANDICAP, T_UNTYPED, "FULL_TIME", "GOALS"),
    ),
    # Full-match BTTS carries a null lifetime AND a null occurrenceType on Kambi;
    # the halves are separate labels ("Both Teams To Score - 1st Half") and are
    # simply absent from this allowlist.
    (Sport.SOCCER, 18, "both teams to score"): (
        KambiRule(MarketType.BTTS, T_YN, None, None),
    ),

    # ---- tennis -------------------------------------------------------------
    (Sport.TENNIS, 2, "match odds"): (
        KambiRule(MarketType.MONEYLINE_2WAY, T_12, None, None),
    ),
    (Sport.TENNIS, 6, "total games"): (
        KambiRule(MarketType.TOTALS, T_OU, None, None),
    ),
    (Sport.TENNIS, 1, "game handicap"): (
        KambiRule(MarketType.HANDICAP, T_12, None, None),
    ),

    # ---- basketball ---------------------------------------------------------
    # Kambi only publishes the incl.-OT basis, and says so in the label.
    (Sport.BASKETBALL, 2, "moneyline - including overtime"): (
        KambiRule(MarketType.MONEYLINE_2WAY, T_12, "FULL_TIME_OVERTIME", "POINTS",
                  ("basketball_ot", "INCLUDED")),
    ),
    (Sport.BASKETBALL, 6, "total points - including overtime"): (
        KambiRule(MarketType.TOTALS, T_OU, "FULL_TIME_OVERTIME", "POINTS",
                  ("basketball_ot", "INCLUDED")),
    ),
    (Sport.BASKETBALL, 1, "point spread - including overtime"): (
        KambiRule(MarketType.HANDICAP, T_12, "FULL_TIME_OVERTIME", "POINTS",
                  ("basketball_ot", "INCLUDED")),
    ),

    # ---- rugby --------------------------------------------------------------
    # "Including Overtime" variants exist on the same event and are deliberately
    # NOT mapped: pairing them with a regular-time quote elsewhere is not an arb.
    (Sport.RUGBY, 2, "regular time"): (
        KambiRule(MarketType.MONEYLINE_2WAY, T_12, None, None),
    ),
    (Sport.RUGBY, 6, "total points"): (
        KambiRule(MarketType.TOTALS, T_OU, None, None),
    ),
    (Sport.RUGBY, 1, "handicap"): (
        KambiRule(MarketType.HANDICAP, T_12, None, None),
    ),

    # ---- cricket ------------------------------------------------------------
    # Limited-overs is a two-way market; multi-day carries the draw.
    (Sport.CRICKET, 2, "match odds"): (
        KambiRule(MarketType.MONEYLINE_2WAY, T_12, None, None),
        KambiRule(MarketType.X12, T_1X2, None, None),
    ),
}

# What mapping through this allowlist guarantees about a Kambi book's settlement
# basis. Consumed by KambiAdapter.rules_profile so venues don't hand-maintain it.
KAMBI_IMPLIED_RULES: dict[str, str] = {
    "soccer_duration": "REG_90",     # criterion lifetime FULL_TIME, 90' + stoppage
    "basketball_ot": "INCLUDED",     # only "- Including Overtime" offers are mapped
    # tennis_retirement is NOT here: Kambi's retirement rule lives in the operator's
    # T&Cs, not the offering payload, so it stays UNVERIFIED until someone reads them.
}


def milli_odds(value: Any) -> float | None:
    """Kambi decimal odds are always milli integers. 1960 -> 1.96."""
    try:
        odds = float(value) / MILLI
    except (TypeError, ValueError):
        return None
    return odds if odds > 1.0 else None


def milli_line(value: Any) -> float | None:
    """Kambi lines are milli and signed. 2500 -> 2.5, -500 -> -0.5."""
    try:
        return float(value) / MILLI
    except (TypeError, ValueError):
        return None


def _parse_start(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None


def _criterion(bo: dict[str, Any]) -> dict[str, Any]:
    return bo.get("criterion") or {}


def _offer_type_id(bo: dict[str, Any]) -> int | None:
    try:
        return int((bo.get("betOfferType") or {}).get("id"))
    except (TypeError, ValueError):
        return None


def classify_bet_offer(bo: dict[str, Any], sport: Sport) -> KambiRule | None:
    """The allowlist gate. Returns the matching rule, or None to refuse the offer."""
    type_id = _offer_type_id(bo)
    crit = _criterion(bo)
    label = str(crit.get("englishLabel") or crit.get("label") or "").strip().casefold()
    if type_id is None or not label:
        return None
    variants = KAMBI_ALLOWLIST.get((sport, type_id, label))
    if not variants:
        return None
    outcomes = bo.get("outcomes") or []
    if not outcomes:
        return None
    observed = frozenset(str(o.get("type") or "") for o in outcomes)
    lifetime = crit.get("lifetime") or None
    occurrence = crit.get("occurrenceType") or None
    for rule in variants:
        if (observed == rule.outcome_types
                and lifetime == rule.lifetime
                and occurrence == rule.occurrence):
            return rule
    return None


def offer_line(bo: dict[str, Any], rule: KambiRule) -> float | None:
    """The canonical line for a mapped offer.

    Totals: both sides carry the same line; disagreement means the payload is not
    what we think it is, so refuse rather than guess.
    Handicaps: the home (OT_ONE) line is the canonical one; the away side mirrors it.
    """
    outcomes = bo.get("outcomes") or []
    if rule.market_type == MarketType.TOTALS:
        lines = {milli_line(o.get("line")) for o in outcomes if o.get("line") is not None}
        if len(lines) != 1:
            return None
        return lines.pop()
    if rule.market_type in (MarketType.HANDICAP, MarketType.ASIAN_HANDICAP):
        for o in outcomes:
            if str(o.get("type")) == "OT_ONE" and o.get("line") is not None:
                return milli_line(o["line"])
        # Asian handicaps are OT_UNTYPED; fall back to the first quoted line.
        for o in outcomes:
            if o.get("line") is not None:
                return milli_line(o["line"])
    return None


class KambiAdapter(SkeletonBookieAdapter):
    """Kambi offering API. Configure with `kambi_base` + `kambi_operator`."""

    def __init__(self, meta: VenueMeta, rules_profile: VenueRulesProfile,
                 endpoints: dict[str, Any] | None = None) -> None:
        endpoints = dict(endpoints or {})
        operator = endpoints.get("kambi_operator")
        base = endpoints.get("kambi_base")
        if operator and base:
            root = f"{str(base).rstrip('/')}/offering/v2018/{operator}"
            params = endpoints.get("kambi_params") or (
                "channel_id=1&client_id=200&lang=en_ZA&market=ZA"
            )
            endpoints.setdefault(
                "events_url",
                f"{root}/listView/{{sport}}.json?{params}&useCombined=true&useCombinedLive=true",
            )
            endpoints.setdefault(
                "odds_url", f"{root}/betoffer/event/{{event_ref}}.json?{params}"
            )
        # Kambi states the settlement basis in the criterion label, and the
        # allowlist only maps offers whose basis is stated — so the profile is
        # derived, not hand-maintained. Explicit config still wins.
        for axis, value in KAMBI_IMPLIED_RULES.items():
            if getattr(rules_profile, axis, None) in (None, "UNVERIFIED"):
                setattr(rules_profile, axis, value)
        super().__init__(meta, rules_profile, endpoints)

    # ------------------------------------------------------------- parsing
    def parse_events(self, payload: Any) -> list[RawEvent]:
        out: list[RawEvent] = []
        for wrapper in (payload or {}).get("events", []) or []:
            ev = wrapper.get("event") if isinstance(wrapper, dict) else None
            ev = ev if isinstance(ev, dict) else (wrapper if isinstance(wrapper, dict) else None)
            if not ev or ev.get("id") is None:
                continue
            state = str(ev.get("state") or "").upper()
            out.append(RawEvent(
                venue_id=self.meta.venue_id,
                ref=str(ev["id"]),
                sport=KAMBI_SPORT_MAP.get(str(ev.get("sport") or "").upper(), Sport.OTHER),
                league_raw=ev.get("group"),
                home_raw=ev.get("homeName"),
                away_raw=ev.get("awayName"),
                title_raw=ev.get("englishName") or ev.get("name"),
                start_time=_parse_start(ev.get("start")),
                status=MarketStatus.CLOSED if state == "FINISHED" else MarketStatus.ACTIVE,
                extra={
                    "path": [p.get("termKey") for p in (ev.get("path") or []) if isinstance(p, dict)],
                    "group_id": ev.get("groupId"),
                    "state": state,
                },
            ))
        return out

    def _sport_of(self, payload: Any, event_ref: str) -> Sport:
        """Bet offers do not name their sport; the envelope's event does."""
        for wrapper in (payload or {}).get("events", []) or []:
            ev = wrapper.get("event") if isinstance(wrapper, dict) and "event" in wrapper else wrapper
            if isinstance(ev, dict) and str(ev.get("id")) == str(event_ref):
                return KAMBI_SPORT_MAP.get(str(ev.get("sport") or "").upper(), Sport.OTHER)
        return Sport.OTHER

    def parse_markets(self, payload: Any, event_ref: str) -> list[RawMarket]:
        sport = self._sport_of(payload, event_ref)
        out: list[RawMarket] = []
        for bo in (payload or {}).get("betOffers", []) or []:
            if not isinstance(bo, dict) or bo.get("id") is None:
                continue
            crit = _criterion(bo)
            rule = classify_bet_offer(bo, sport)
            selections = [
                RawSelection(
                    ref=str(o.get("id")),
                    name_raw=str(o.get("englishLabel") or o.get("label")
                                 or o.get("participant") or ""),
                    outcome_hint=str(o.get("type") or ""),
                )
                for o in (bo.get("outcomes") or []) if o.get("id") is not None
            ]
            out.append(RawMarket(
                venue_id=self.meta.venue_id,
                event_ref=event_ref,
                ref=str(bo["id"]),
                market_type=rule.market_type if rule else None,
                market_type_raw=str(crit.get("englishLabel") or crit.get("label") or ""),
                line=offer_line(bo, rule) if rule else None,
                selections=selections,
                status=MarketStatus.SUSPENDED if bo.get("suspended") else MarketStatus.ACTIVE,
                extra={
                    "bet_offer_type_id": _offer_type_id(bo),
                    "lifetime": crit.get("lifetime"),
                    "occurrence_type": crit.get("occurrenceType"),
                    "rules_axis": list(rule.rules_axis) if rule and rule.rules_axis else None,
                    "mapped": rule is not None,
                },
            ))
        return out

    def parse_odds(self, payload: Any, event_ref: str) -> list[RawOddsUpdate]:
        sport = self._sport_of(payload, event_ref)
        out: list[RawOddsUpdate] = []
        for bo in (payload or {}).get("betOffers", []) or []:
            if not isinstance(bo, dict) or bo.get("id") is None:
                continue
            rule = classify_bet_offer(bo, sport)
            if rule is None:
                continue  # unmapped market: carried as RawMarket, never priced
            suspended = bool(bo.get("suspended"))
            for o in bo.get("outcomes") or []:
                odds = milli_odds(o.get("odds"))
                if odds is None or o.get("id") is None:
                    continue
                status = str(o.get("status") or "OPEN").upper()
                if status in ("SUSPENDED", "CLOSED", "SETTLED"):
                    continue
                out.append(RawOddsUpdate(
                    venue_id=self.meta.venue_id,
                    event_ref=event_ref,
                    market_ref=str(bo["id"]),
                    selection_ref=str(o["id"]),
                    decimal_odds=odds,
                    line=(milli_line(o["line"]) if o.get("line") is not None
                          else offer_line(bo, rule)),
                    status=MarketStatus.SUSPENDED if suspended else MarketStatus.ACTIVE,
                    max_stake=self.meta.max_stake_default,
                    ts_source=utcnow(),
                    ts_ingest=utcnow(),
                    extra={"market_type": str(rule.market_type)},
                ))
        return out

    # ---------------------------------------------------------- interface
    async def discover_events(self, sport: str) -> list[RawEvent]:
        """`sport` may be a canonical Sport value or a raw Kambi term path."""
        self._require_config()
        paths = self._paths_for(sport)
        events: dict[str, RawEvent] = {}
        for path in paths:
            try:
                payload = await self.get_json(self.endpoints["events_url"].format(sport=path))
            except Exception:  # noqa: BLE001 — a dead path must not kill the sweep
                continue
            for ev in self.parse_events(payload):
                events[ev.ref] = ev
        return list(events.values())

    def _paths_for(self, sport: str) -> tuple[str, ...]:
        explicit = (self.endpoints.get("sport_paths") or {}).get(sport)
        if explicit:
            return tuple(explicit)
        try:
            return KAMBI_SPORT_PATHS.get(Sport(sport), (sport,))
        except ValueError:
            return (sport,)

    async def fetch_markets(self, event_ref: str) -> list[RawMarket]:
        self._require_config()
        payload = await self.get_json(self.endpoints["odds_url"].format(event_ref=event_ref))
        return self.parse_markets(payload, event_ref)
