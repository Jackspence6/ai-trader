"""Venue settlement-rules profiles + compatibility matrix (spec §4.6 / §14.4).

Bookmaker settlement-rule differences break arbs. Legs are only a *pure* arb when
every pairwise combination sits in the same rules group for the market's decisive
axis. Anything else is flagged rule_risk (scored down, never labelled pure).

Axes (starter matrix, extend per venue T&Cs):
- tennis_retirement: BALL_SERVED | ONE_SET | MATCH_COMPLETED
- basketball_ot:     INCLUDED | REGULATION_ONLY
- soccer_duration:   REG_90 | INCL_ET
- dnb_void:          DNB vs 1X2 void behavior (market-type level, handled in engine)
- palpable_error / dead_heat: per-venue void clauses -> venue-level risk note
- Polymarket:        resolution source is UMA/oracle and postponement handling is
                     per-market -> axes default to PER_MARKET (always rule_risk when
                     paired with a bookie until the operator verifies the market's
                     resolution text and pins a group via the review queue).

UNVERIFIED axis values never match anything (including themselves): an unverified
pair can still be alerted, but only ever as rule-risk.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import MarketType, Sport

UNVERIFIED = "UNVERIFIED"
PER_MARKET = "PER_MARKET"

# Which axis decides compatibility for a given (sport, market_type)
DECISIVE_AXIS: dict[tuple[Sport, MarketType], str] = {
    (Sport.TENNIS, MarketType.MONEYLINE_2WAY): "tennis_retirement",
    (Sport.BASKETBALL, MarketType.MONEYLINE_2WAY): "basketball_ot",
    (Sport.BASKETBALL, MarketType.TOTALS): "basketball_ot",
    (Sport.BASKETBALL, MarketType.HANDICAP): "basketball_ot",
    (Sport.SOCCER, MarketType.MONEYLINE_2WAY): "soccer_duration",  # knockout "to qualify" style
    (Sport.SOCCER, MarketType.X12): "soccer_duration",
}


@dataclass
class VenueRulesProfile:
    venue_id: str
    tennis_retirement: str = UNVERIFIED
    basketball_ot: str = UNVERIFIED
    soccer_duration: str = UNVERIFIED
    palpable_error_void: bool = True     # assume the venue can void palpable errors
    dead_heat_reduction: bool = True
    notes: dict[str, str] = field(default_factory=dict)

    def axis(self, name: str) -> str:
        return getattr(self, name, UNVERIFIED)


def rules_group(profile: VenueRulesProfile, sport: Sport, market_type: MarketType) -> str:
    """The group label a quote carries; identical labels (and not UNVERIFIED/PER_MARKET)
    are clean-arb compatible."""
    axis = DECISIVE_AXIS.get((sport, market_type))
    if axis is None:
        # Markets with no known decisive axis: treat identical market types as compatible
        # but keep venue-level void risk in scoring.
        return "DEFAULT"
    return profile.axis(axis)


def compatible(group_a: str, group_b: str) -> tuple[bool, str | None]:
    """Return (clean, note). Unverified/per-market groups are never clean."""
    if group_a in (UNVERIFIED, PER_MARKET) or group_b in (UNVERIFIED, PER_MARKET):
        return False, f"rules unverified ({group_a} vs {group_b})"
    if group_a != group_b:
        return False, f"settlement rules differ ({group_a} vs {group_b})"
    return True, None


def legs_clean(groups: list[str]) -> tuple[bool, str | None]:
    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            ok, note = compatible(groups[i], groups[j])
            if not ok:
                return False, note
    return True, None


# Profiles for known venues. Real SA books ship UNVERIFIED until the operator encodes
# each book's T&Cs (ops/runbook.md documents where to look); mock venues (demo/tests)
# get concrete values to exercise the matrix.
def default_profiles() -> dict[str, VenueRulesProfile]:
    return {
        "polymarket": VenueRulesProfile(
            venue_id="polymarket",
            tennis_retirement=PER_MARKET,
            basketball_ot=PER_MARKET,
            soccer_duration=PER_MARKET,
            palpable_error_void=False,
            notes={
                "resolution": "UMA/oracle; postponement handling is per-market — verify the market's "
                "resolution text before treating a PM leg as clean. Exclude post-game snapshots "
                "(order book hollows out; ~7,532 bps median post-game spread in the NBA study)."
            },
        ),
        "betway_sa": VenueRulesProfile(venue_id="betway_sa"),
        "hollywoodbets": VenueRulesProfile(venue_id="hollywoodbets"),
        "supabets": VenueRulesProfile(venue_id="supabets"),
        "sunbet": VenueRulesProfile(venue_id="sunbet"),
    }
