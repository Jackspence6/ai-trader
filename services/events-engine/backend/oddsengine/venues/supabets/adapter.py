"""Supabets adapter — SKELETON pending endpoint discovery (spec §14.2).

Evidence so far: **WA.Technology confirmed** (WA.Sports / WA.Platform; OpticOdds data
supplier). WA.Platform is an SPA with JSON endpoints visible in DevTools; the host and
payload shapes still must be captured before enabling — see discovery.md.
"""

from __future__ import annotations

from typing import Any

from ...models import VenueKind
from ...rules import VenueRulesProfile
from ..base import VenueMeta
from ..skeleton import SkeletonBookieAdapter


class SupabetsAdapter(SkeletonBookieAdapter):
    VENUE_ID = "supabets"

    def __init__(self, endpoints: dict[str, Any] | None = None, *, enabled: bool = False,
                 softness: float = 0.65, max_stake_default: float = 10000.0) -> None:
        meta = VenueMeta(
            venue_id=self.VENUE_ID, name="Supabets", kind=VenueKind.BOOKIE,
            softness=softness, min_interval_s=20.0, max_stake_default=max_stake_default,
            homepage="https://www.supabets.co.za", enabled=enabled,
        )
        super().__init__(meta, VenueRulesProfile(venue_id=self.VENUE_ID), endpoints)
