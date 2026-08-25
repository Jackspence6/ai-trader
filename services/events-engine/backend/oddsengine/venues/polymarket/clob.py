"""CLOB API client — read-only Phase 1 (books, prices, live fee rates).

CLOB V2 context (spec §3.4, hard cutover 2026-04-28): collateral is pUSD, order
signing changed, legacy py-clob-client is retired and signed orders must carry
feeRateBps. None of that touches these read paths, but execution (Phase 3) must use
py-clob-client-v2 — see execution.py.

Read rate limits ~9,000/10s; we poll books only as WS backfill.
"""

from __future__ import annotations

import httpx

from ...observability import get_logger
from .parsing import ParsedBook, parse_book, parse_fee_rate

log = get_logger("polymarket.clob")


class ClobClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=15, headers={"Accept": "application/json"})
        self._fee_cache: dict[str, float] = {}

    async def close(self) -> None:
        await self._client.aclose()

    async def book(self, token_id: str) -> ParsedBook | None:
        try:
            resp = await self._client.get(f"{self.base_url}/book", params={"token_id": token_id})
            resp.raise_for_status()
            payload = resp.json()
            if isinstance(payload, dict) and "asset_id" not in payload and "token_id" not in payload:
                payload = {**payload, "asset_id": token_id}
            return parse_book(payload)
        except httpx.HTTPError as exc:
            log.warning("clob_book_failed", token_id=token_id[:16], error=str(exc))
            return None

    async def fee_rate(self, token_id: str, fallback: float) -> float:
        """Live taker fee rate for a market. ALWAYS prefer this over the docs table
        (spec §14.3: 'Read /fee-rate live per market' — docs and endpoint have disagreed).
        Cached per token for the process lifetime; scheduler refreshes periodically."""
        if token_id in self._fee_cache:
            return self._fee_cache[token_id]
        try:
            resp = await self._client.get(f"{self.base_url}/fee-rate", params={"token_id": token_id})
            resp.raise_for_status()
            rate = parse_fee_rate(resp.json(), fallback)
        except httpx.HTTPError as exc:
            log.warning("clob_fee_rate_failed", token_id=token_id[:16], error=str(exc), fallback=fallback)
            rate = fallback
        self._fee_cache[token_id] = rate
        return rate

    def invalidate_fee_cache(self) -> None:
        self._fee_cache.clear()
