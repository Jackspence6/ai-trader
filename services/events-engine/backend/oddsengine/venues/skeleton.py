"""Discovery-driven skeleton for SA bookmaker adapters.

Spec §3.2 is explicit: no aggregator covers SA books and endpoint hosts are largely
unconfirmed — each book's frontend JSON/GraphQL/WS endpoint must be discovered via
DevTools/HAR from an SA-resident IP and recorded in the adapter's discovery files.
Skeletons therefore ship UNCONFIGURED and refuse to fabricate endpoints.

To activate a book:
1. Follow ops/runbook.md ("Endpoint discovery procedure") for the book.
2. Fill config/venues.yaml -> venues.<venue_id>.endpoints (events_url, odds_url, mode...).
3. Implement/adjust `parse_events` / `parse_odds` for the captured payload shape
   in the venue's adapter module, guided by its discovery.md notes.
4. Flip enabled: true. The adapter then paces requests, reports health and emits
   RawOddsUpdate like any other venue.

mode: "httpx" for plain JSON endpoints; "playwright" for heavy SPAs behind
Cloudflare (Hollywoodbets confirmed) — a real browser context on public odds pages
with respectful pacing. Never touch login/account endpoints (spec §3.3).
"""

from __future__ import annotations

from typing import Any

import httpx

from ..models import RawEvent, RawMarket, RawOddsUpdate
from ..observability import get_logger
from ..rules import VenueRulesProfile
from .base import DEFAULT_UA, AdapterNotConfigured, BaseAdapter, VenueMeta

log = get_logger("venues.skeleton")


class SkeletonBookieAdapter(BaseAdapter):
    """Functional shell: pacing, health, HTTP plumbing — parsing is per-book."""

    def __init__(self, meta: VenueMeta, rules_profile: VenueRulesProfile,
                 endpoints: dict[str, Any] | None = None) -> None:
        super().__init__(meta, rules_profile)
        self.endpoints = endpoints or {}
        self._client: httpx.AsyncClient | None = None

    @property
    def configured(self) -> bool:
        return bool(self.endpoints.get("events_url"))

    def _require_config(self) -> None:
        if not self.configured or not self.meta.enabled:
            raise AdapterNotConfigured(
                f"{self.meta.venue_id}: endpoints not discovered yet. Run the DevTools/HAR "
                f"procedure in ops/runbook.md and fill config/venues.yaml (see the adapter's "
                f"discovery.md for evidence gathered so far)."
            )

    async def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=20,
                headers={"User-Agent": DEFAULT_UA, "Accept": "application/json",
                         **(self.endpoints.get("headers") or {})},
            )
        return self._client

    async def get_json(self, url: str, **params: Any) -> Any:
        await self.pace()
        client = await self.client()
        try:
            resp = await client.get(url, params=params or None)
            resp.raise_for_status()
            self.note_success()
            return resp.json()
        except httpx.HTTPError:
            self.note_error()
            raise

    # ---- per-book parsing hooks (implement after discovery) ----
    def parse_events(self, payload: Any) -> list[RawEvent]:
        raise AdapterNotConfigured(f"{self.meta.venue_id}: parse_events not implemented (see discovery.md)")

    def parse_odds(self, payload: Any, event_ref: str) -> list[RawOddsUpdate]:
        raise AdapterNotConfigured(f"{self.meta.venue_id}: parse_odds not implemented (see discovery.md)")

    # ---- adapter interface ----
    async def discover_events(self, sport: str) -> list[RawEvent]:
        self._require_config()
        payload = await self.get_json(self.endpoints["events_url"].format(sport=sport))
        return self.parse_events(payload)

    async def fetch_markets(self, event_ref: str) -> list[RawMarket]:
        self._require_config()
        return []

    async def fetch_odds(self, event_ref: str) -> list[RawOddsUpdate]:
        self._require_config()
        url = self.endpoints.get("odds_url")
        if not url:
            return []
        payload = await self.get_json(url.format(event_ref=event_ref))
        return self.parse_odds(payload, event_ref)


async def playwright_network_tap(url: str, url_pattern: str, *, wait_ms: int = 8000,
                                 headless: bool = True) -> list[dict[str, Any]]:
    """Open a public odds page in a real browser and collect JSON responses whose URL
    matches `url_pattern`. This is the discovery aid / Cloudflare-SPA fallback for
    books whose odds only render client-side (spec §3.2). Requires `pip install
    oddsengine[scrape]` + `playwright install chromium`.

    Deliberately NOT stealthy: one real browser context, believable pacing, public
    pages only. If a book blocks this, the answer is slower polling — not evasion.
    """
    import re

    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover
        raise AdapterNotConfigured("playwright not installed: pip install 'oddsengine[scrape]'") from exc

    captured: list[dict[str, Any]] = []
    pattern = re.compile(url_pattern)
    async with async_playwright() as pw:  # pragma: no cover — needs a browser
        browser = await pw.chromium.launch(headless=headless)
        context = await browser.new_context(user_agent=DEFAULT_UA)
        page = await context.new_page()

        async def on_response(resp):  # noqa: ANN001
            if pattern.search(resp.url) and "json" in (resp.headers.get("content-type") or ""):
                try:
                    captured.append({"url": resp.url, "json": await resp.json()})
                except Exception:  # noqa: BLE001
                    pass

        page.on("response", on_response)
        await page.goto(url, wait_until="networkidle", timeout=45_000)
        await page.wait_for_timeout(wait_ms)
        await browser.close()
    return captured
