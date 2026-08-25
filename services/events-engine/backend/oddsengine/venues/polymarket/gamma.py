"""Gamma API client (public, no key) — discovery + metadata (spec §3.4).

Rate limit context: Cloudflare IP-based, ~4,000 req/10s — our polling is orders of
magnitude below this, but we still pace and jitter like everywhere else.
"""

from __future__ import annotations

from typing import Any

import httpx

from ...observability import get_logger
from .parsing import ParsedMarket, parse_gamma_market

log = get_logger("polymarket.gamma")


class GammaClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=15, headers={"Accept": "application/json"})

    async def close(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, **params: Any) -> Any:
        resp = await self._client.get(f"{self.base_url}{path}", params=params)
        resp.raise_for_status()
        return resp.json()

    async def list_events(self, *, tag_slug: str | None = None, closed: bool = False,
                          limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit, "offset": offset, "closed": str(closed).lower()}
        if tag_slug:
            params["tag_slug"] = tag_slug
        data = await self._get("/events", **params)
        return data if isinstance(data, list) else data.get("data", [])

    async def list_markets(self, *, closed: bool = False, limit: int = 100,
                           offset: int = 0) -> list[dict[str, Any]]:
        data = await self._get("/markets", limit=limit, offset=offset, closed=str(closed).lower())
        return data if isinstance(data, list) else data.get("data", [])

    async def sports_markets(self, tags: list[str], limit_per_tag: int = 100) -> list[ParsedMarket]:
        """Discover open sports markets across the configured tag slugs, deduped by condition id."""
        seen: dict[str, ParsedMarket] = {}
        for tag in tags:
            try:
                events = await self.list_events(tag_slug=tag, closed=False, limit=limit_per_tag)
            except httpx.HTTPError as exc:
                log.warning("gamma_tag_failed", tag=tag, error=str(exc))
                continue
            for ev in events:
                for m in ev.get("markets") or []:
                    parsed = parse_gamma_market(m, event=ev)
                    if parsed and not parsed.closed and parsed.condition_id not in seen:
                        seen[parsed.condition_id] = parsed
        return list(seen.values())
