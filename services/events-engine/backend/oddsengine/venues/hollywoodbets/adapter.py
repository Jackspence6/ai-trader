"""Hollywoodbets adapter — SKELETON pending endpoint discovery (spec §14.2).

Evidence so far: in-house "BET Software"/"SyX" platform (Elixir/Erlang), DATA.BET
esports iFrame, **Cloudflare + reCAPTCHA confirmed**. Expect the Playwright fallback
(real browser context, respectful pacing) rather than plain httpx — see
skeleton.playwright_network_tap and discovery.md.
"""

from __future__ import annotations

from typing import Any

from ...models import RawOddsUpdate, VenueKind
from ...rules import VenueRulesProfile
from ..base import VenueMeta
from ..skeleton import SkeletonBookieAdapter, playwright_network_tap


class HollywoodbetsAdapter(SkeletonBookieAdapter):
    VENUE_ID = "hollywoodbets"

    def __init__(self, endpoints: dict[str, Any] | None = None, *, enabled: bool = False,
                 softness: float = 0.6, max_stake_default: float = 10000.0) -> None:
        meta = VenueMeta(
            venue_id=self.VENUE_ID, name="Hollywoodbets", kind=VenueKind.BOOKIE,
            softness=softness, min_interval_s=30.0,  # Cloudflare: slower, gentler
            max_stake_default=max_stake_default,
            homepage="https://www.hollywoodbets.net", enabled=enabled,
        )
        super().__init__(meta, VenueRulesProfile(venue_id=self.VENUE_ID), endpoints)

    async def fetch_odds_via_browser(self, event_url: str) -> list[RawOddsUpdate]:
        """Playwright network-tap path for the Cloudflare SPA (once discovery.yaml
        records the XHR url_pattern that carries odds JSON)."""
        self._require_config()
        pattern = self.endpoints.get("xhr_pattern")
        if not pattern:
            return []
        captured = await playwright_network_tap(event_url, pattern)
        out: list[RawOddsUpdate] = []
        for item in captured:
            out.extend(self.parse_odds(item["json"], event_ref=event_url))
        return out
