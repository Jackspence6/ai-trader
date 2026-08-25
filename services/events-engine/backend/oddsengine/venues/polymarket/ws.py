"""CLOB WebSocket consumer — market channel (public), the live path for anything live.

Spec §3.4: "Use WS, not REST polling, for anything live." The 500ms taker delay was
removed 2026-02-18, so latency is the only moat — which is exactly why Phase 1 keeps
live Polymarket arbs alert/measure-only.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import websockets

from ...observability import get_logger
from .parsing import ParsedBook, parse_book, parse_ws_messages

log = get_logger("polymarket.ws")


class MarketChannelConsumer:
    def __init__(self, ws_url: str) -> None:
        self.ws_url = ws_url if ws_url.endswith("market") else ws_url.rstrip("/") + "/market"
        self._token_ids: set[str] = set()
        self._resubscribe = asyncio.Event()

    def set_tokens(self, token_ids: set[str]) -> None:
        if token_ids != self._token_ids:
            self._token_ids = set(token_ids)
            self._resubscribe.set()

    async def books(self) -> AsyncIterator[ParsedBook]:
        """Yield full book states. price_change deltas are folded into the local book."""
        backoff = 1.0
        local_books: dict[str, ParsedBook] = {}
        while True:
            if not self._token_ids:
                await asyncio.sleep(1.0)
                continue
            try:
                async with websockets.connect(self.ws_url, ping_interval=10, ping_timeout=10) as ws:
                    await ws.send(json.dumps({"assets_ids": sorted(self._token_ids), "type": "market"}))
                    self._resubscribe.clear()
                    backoff = 1.0
                    log.info("ws_subscribed", tokens=len(self._token_ids))
                    while True:
                        if self._resubscribe.is_set():
                            break  # reconnect with the new token set
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=30)
                        except TimeoutError:
                            continue
                        for msg in parse_ws_messages(raw):
                            book = self._handle(msg, local_books)
                            if book is not None:
                                yield book
            except (websockets.WebSocketException, OSError) as exc:
                log.warning("ws_disconnected", error=str(exc), retry_in=backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    def _handle(self, msg: dict, local_books: dict[str, ParsedBook]) -> ParsedBook | None:
        etype = msg.get("event_type") or msg.get("type")
        if etype == "book":
            book = parse_book(msg)
            if book:
                local_books[book.token_id] = book
            return book
        if etype == "price_change":
            token_id = str(msg.get("asset_id") or msg.get("market") or "")
            book = local_books.get(token_id)
            if not book:
                return None  # no snapshot yet; wait for the next 'book'
            changes = msg.get("changes") or [msg]
            for ch in changes:
                self._apply_change(book, ch)
            book.bids.sort(key=lambda x: -x.price)
            book.asks.sort(key=lambda x: x.price)
            return book
        # tick_size_change / last_trade_price / unknown types: ignored by design
        return None

    @staticmethod
    def _apply_change(book: ParsedBook, ch: dict) -> None:
        from ...models import BookLevel
        from .parsing import as_float

        price = as_float(ch.get("price"))
        size = as_float(ch.get("size"))
        side = str(ch.get("side") or "").upper()
        if price is None or size is None or side not in ("BUY", "SELL"):
            return
        levels = book.bids if side == "BUY" else book.asks
        for i, lvl in enumerate(levels):
            if abs(lvl.price - price) < 1e-9:
                if size <= 0:
                    levels.pop(i)
                else:
                    levels[i] = BookLevel(price=price, size=size)
                return
        if size > 0:
            levels.append(BookLevel(price=price, size=size))
