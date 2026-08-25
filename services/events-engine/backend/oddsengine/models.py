"""Canonical domain models. Everything downstream of the venue adapters is venue-agnostic."""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from .compat import UTC, StrEnum


def utcnow() -> datetime:
    return datetime.now(UTC)


class VenueKind(StrEnum):
    BOOKIE = "bookie"
    PREDICTION_MARKET = "prediction_market"


class Sport(StrEnum):
    SOCCER = "soccer"
    TENNIS = "tennis"
    BASKETBALL = "basketball"
    RUGBY = "rugby"
    CRICKET = "cricket"
    AMERICAN_FOOTBALL = "american_football"
    MMA = "mma"
    ESPORTS = "esports"
    OTHER = "other"


class MarketType(StrEnum):
    X12 = "1X2"
    MONEYLINE_2WAY = "MONEYLINE_2WAY"
    DNB = "DNB"
    TOTALS = "TOTALS"
    HANDICAP = "HANDICAP"
    ASIAN_HANDICAP = "ASIAN_HANDICAP"
    BTTS = "BTTS"
    OUTRIGHT = "OUTRIGHT"
    PROP = "PROP"
    BINARY_YESNO = "BINARY_YESNO"      # Polymarket single binary market
    NEGRISK_MULTI = "NEGRISK_MULTI"    # Polymarket negRisk multi-outcome event


# Canonical outcome labels per market type. NEGRISK outcomes are "OUT:<n>".
class Outcome(StrEnum):
    HOME = "HOME"
    DRAW = "DRAW"
    AWAY = "AWAY"
    OVER = "OVER"
    UNDER = "UNDER"
    YES = "YES"
    NO = "NO"
    BTTS_YES = "BTTS_YES"
    BTTS_NO = "BTTS_NO"


OUTCOME_SETS: dict[MarketType, tuple[str, ...]] = {
    MarketType.X12: (Outcome.HOME, Outcome.DRAW, Outcome.AWAY),
    MarketType.MONEYLINE_2WAY: (Outcome.HOME, Outcome.AWAY),
    MarketType.DNB: (Outcome.HOME, Outcome.AWAY),
    MarketType.TOTALS: (Outcome.OVER, Outcome.UNDER),
    MarketType.HANDICAP: (Outcome.HOME, Outcome.AWAY),
    MarketType.ASIAN_HANDICAP: (Outcome.HOME, Outcome.AWAY),
    MarketType.BTTS: (Outcome.BTTS_YES, Outcome.BTTS_NO),
    MarketType.BINARY_YESNO: (Outcome.YES, Outcome.NO),
}


class MarketStatus(StrEnum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    CLOSED = "closed"


class TimingClass(StrEnum):
    PRE_MATCH = "pre_match"
    NEAR_KICKOFF = "near_kickoff"
    LIVE = "live"


class Urgency(StrEnum):
    LOW = "low"          # pre-match, hours out
    MEDIUM = "medium"    # today
    HIGH = "high"        # near kickoff
    CRITICAL = "critical"  # live / very fast decay — measure-only for manual flow


class OpportunityType(StrEnum):
    BOOKIE_BOOKIE = "bookie_vs_bookie"
    BOOKIE_POLYMARKET = "bookie_vs_polymarket"
    POLYMARKET_INTERNAL = "polymarket_internal"
    PROMO_BOOST = "promo_boost"          # Phase 1: detected when a venue flags boosted odds
    PROMO_ROLLOVER = "promo_rollover"    # Phase 2


class OppState(StrEnum):
    ACTIVE = "active"
    EXPIRED = "expired"


class HealthState(StrEnum):
    OK = "ok"
    DEGRADED = "degraded"
    STALE = "stale"
    QUARANTINED = "quarantined"
    UNCONFIGURED = "unconfigured"


# ---------------------------------------------------------------- raw layer

class BookLevel(BaseModel):
    price: float
    size: float  # shares (PM) or ZAR notional capacity (bookie max stake expressed per level)


class RawEvent(BaseModel):
    venue_id: str
    ref: str                      # venue-native event reference
    sport: Sport
    league_raw: str | None = None
    home_raw: str | None = None
    away_raw: str | None = None
    title_raw: str | None = None  # e.g. Polymarket question/title when home/away not split
    start_time: datetime | None = None
    status: MarketStatus = MarketStatus.ACTIVE
    extra: dict[str, Any] = Field(default_factory=dict)


class RawSelection(BaseModel):
    ref: str
    name_raw: str
    outcome_hint: str | None = None  # adapter may pre-map (e.g. PM YES/NO tokens)


class RawMarket(BaseModel):
    venue_id: str
    event_ref: str
    ref: str
    market_type: MarketType | None = None
    market_type_raw: str | None = None
    line: float | None = None
    selections: list[RawSelection] = Field(default_factory=list)
    status: MarketStatus = MarketStatus.ACTIVE
    neg_risk_group: str | None = None   # PM negRisk event id
    neg_risk_complete: bool = False     # adapter confirms full outcome set is tracked
    neg_risk_size: int | None = None    # number of outcomes in the complete set
    extra: dict[str, Any] = Field(default_factory=dict)


class RawOddsUpdate(BaseModel):
    """The single unit every adapter emits. Bookies set decimal_odds; PM sets pm_* fields."""

    venue_id: str
    event_ref: str
    market_ref: str
    selection_ref: str
    decimal_odds: float | None = None
    pm_buy_price: float | None = None       # best ask (cost to acquire 1 share of this outcome)
    pm_sell_price: float | None = None      # best bid
    pm_fee_rate: float | None = None        # live /fee-rate value (taker), NOT the docs table
    line: float | None = None
    status: MarketStatus = MarketStatus.ACTIVE
    max_stake: float | None = None          # bookie max stake in venue currency, if known
    depth: list[BookLevel] | None = None    # PM ask levels for buys
    ts_source: datetime = Field(default_factory=utcnow)
    ts_ingest: datetime = Field(default_factory=utcnow)
    extra: dict[str, Any] = Field(default_factory=dict)


# ------------------------------------------------------------ canonical layer

class CanonicalEvent(BaseModel):
    id: str
    sport: Sport
    league: str | None = None
    home: str | None = None
    away: str | None = None
    start_time: datetime | None = None
    venue_refs: dict[str, str] = Field(default_factory=dict)  # venue_id -> venue event ref

    @property
    def label(self) -> str:
        if self.home and self.away:
            return f"{self.home} vs {self.away}"
        return self.home or self.away or self.id


def market_key(market_type: MarketType | str, line: float | None = None,
               qualifier: str | None = None) -> str:
    """Canonical market key: '<TYPE>|<line>|<qualifier>'. The qualifier scopes markets
    that must not collide (e.g. distinct Polymarket binary questions on one event)."""
    mt = market_type.value if isinstance(market_type, MarketType) else str(market_type)
    line_part = f"{line:g}" if line is not None else ""
    return f"{mt}|{line_part}|{qualifier or ''}".rstrip("|") if qualifier else f"{mt}|{line_part}"


def parse_market_key(key: str) -> tuple[str, float | None]:
    parts = key.split("|")
    mt = parts[0]
    line = float(parts[1]) if len(parts) > 1 and parts[1] else None
    return mt, line


class Quote(BaseModel):
    """Normalized best-price cell for (event, market, outcome, venue) held in hot state."""

    venue_id: str
    event_id: str
    market_key: str
    outcome: str
    odds_eff: float                  # decimal odds; for PM legs this is fee-adjusted (1 / p_eff)
    raw_price: float | None = None   # PM raw ask price
    fee_rate: float | None = None
    is_pm: bool = False
    token_id: str | None = None
    mirror_of: str | None = None     # token id this quote mirrors (deduped PM liquidity)
    line: float | None = None
    status: MarketStatus = MarketStatus.ACTIVE
    rules_group: str = "UNVERIFIED"
    max_stake_zar: float | None = None
    depth: list[BookLevel] | None = None
    selection_label: str = ""
    deep_link: str = ""
    neg_risk_group: str | None = None
    neg_risk_complete: bool = False
    neg_risk_size: int | None = None
    ts_source: datetime = Field(default_factory=utcnow)
    ts_ingest: datetime = Field(default_factory=utcnow)

    def age_s(self, now: datetime | None = None) -> float:
        return ((now or utcnow()) - self.ts_ingest).total_seconds()


# ----------------------------------------------------------- opportunities

class Leg(BaseModel):
    venue_id: str
    venue_name: str
    outcome: str
    selection_label: str
    odds: float                     # effective decimal odds used in the arb math
    raw_price: float | None = None
    fee_rate: float | None = None
    stake_zar: float = 0.0
    deep_link: str = ""
    rules_group: str = "UNVERIFIED"
    is_pm: bool = False
    token_id: str | None = None
    max_stake_zar: float | None = None
    order_index: int = 0            # 1 = place first (soft/slow book), N = last (sharp/deep)


class Opportunity(BaseModel):
    id: str
    opp_type: OpportunityType
    event_id: str
    event_label: str
    sport: Sport
    league: str | None = None
    start_time: datetime | None = None
    market_key: str
    legs: list[Leg]
    margin_pct: float                       # fee-adjusted margin, percent
    total_stake_zar: float = 0.0
    guaranteed_profit_zar: float = 0.0      # worst-case profit after stake naturalization
    roi_pct: float = 0.0
    executable_zar_per_leg: float = 0.0     # min over legs of the stake each leg can absorb at balance
    stakes_natural: bool = True
    score: float = 0.0
    score_breakdown: dict[str, float] = Field(default_factory=dict)
    urgency: Urgency = Urgency.LOW
    timing: TimingClass = TimingClass.PRE_MATCH
    rule_risk: bool = False
    rule_risk_note: str | None = None
    mirrored: bool = False
    fx_rate: float | None = None            # buffered USDZAR applied to PM legs
    first_seen: datetime = Field(default_factory=utcnow)
    last_seen: datetime = Field(default_factory=utcnow)
    peak_margin_pct: float = 0.0
    state: OppState = OppState.ACTIVE
    window_s: float | None = None           # filled on expiry
    notes: list[str] = Field(default_factory=list)

    @staticmethod
    def make_id(event_id: str, mkey: str, legs: list[tuple[str, str]]) -> str:
        blob = event_id + "|" + mkey + "|" + "|".join(f"{v}:{o}" for v, o in sorted(legs))
        return hashlib.sha1(blob.encode()).hexdigest()[:12]


class HealthStatus(BaseModel):
    venue_id: str
    state: HealthState = HealthState.OK
    last_success: datetime | None = None
    error_rate: float = 0.0            # rolling error fraction
    consecutive_errors: int = 0
    staleness_s: float | None = None
    note: str | None = None
    ts: datetime = Field(default_factory=utcnow)


class PlacementFeedback(BaseModel):
    opportunity_id: str
    status: str                        # placed | missed | voided | partial
    leg_idx: int | None = None
    actual_odds: float | None = None
    actual_stake_zar: float | None = None
    note: str | None = None
    ts: datetime = Field(default_factory=utcnow)
