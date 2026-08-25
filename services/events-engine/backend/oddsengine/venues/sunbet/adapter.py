"""Sunbet adapter — Kambi offering API (spec §14.2).

Sun International runs its sportsbook on Kambi (partnership since Nov 2017,
extended July 2024). The public site at sunbet.co.za/en/sports is a Shape Games
front end, which is why the platform is not obvious from the page — but the odds
themselves come straight from Kambi's offering API.

Captured live from a South African IP on 2026-08-25 (see discovery.md):

    base      https://eu.offering-api.kambicdn.com
    operator  siwc
    params    channel_id=1&client_id=200&lang=en_ZA&market=ZA

All parsing lives in venues/kambi.py, including the market allowlist that keeps
half-time, team-total and corner markets from colliding with the match markets
they superficially resemble.
"""

from __future__ import annotations

from typing import Any

from ...models import VenueKind
from ...rules import VenueRulesProfile
from ..base import VenueMeta
from ..kambi import KambiAdapter


class SunbetAdapter(KambiAdapter):
    VENUE_ID = "sunbet"

    def __init__(self, endpoints: dict[str, Any] | None = None, *, enabled: bool = False,
                 softness: float = 0.55, max_stake_default: float = 10000.0) -> None:
        meta = VenueMeta(
            venue_id=self.VENUE_ID, name="Sunbet", kind=VenueKind.BOOKIE,
            softness=softness, min_interval_s=15.0, max_stake_default=max_stake_default,
            homepage="https://www.sunbet.co.za",
            deep_link_template="https://www.sunbet.co.za/en/sports#/event/{event_ref}",
            enabled=enabled,
        )
        # soccer_duration / basketball_ot are filled by KambiAdapter from the
        # criterion labels the allowlist accepts. tennis_retirement stays
        # UNVERIFIED: that rule is in Sunbet's T&Cs, not in the odds payload, so
        # tennis legs stay rule-risk until a human reads them.
        super().__init__(meta, VenueRulesProfile(venue_id=self.VENUE_ID), endpoints)
