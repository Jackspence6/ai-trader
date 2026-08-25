"""Telegram Bot API client (primary alert channel, spec §6) with dry-run mode.

Dry-run (Phase 1 default): alerts are logged to state + stdout instead of sent, so
the full alert->feedback loop is exercisable with no bot token. With a token set,
alerts go to the configured channel and inline-button feedback is consumed via
long-polling getUpdates.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..observability import METRICS, get_logger

log = get_logger("telegram")

API = "https://api.telegram.org"


class TelegramClient:
    def __init__(self, token: str | None, dry_run: bool = True) -> None:
        self.token = token
        self.dry_run = dry_run or not token
        self._client = httpx.AsyncClient(timeout=30) if not self.dry_run else None
        self._offset = 0

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()

    async def send(self, chat_id: str, text: str, reply_markup: dict | None = None) -> dict[str, Any]:
        if self.dry_run:
            log.info("alert_dry_run", chat_id=chat_id or "(unset)", text=text)
            METRICS.inc("telegram.dry_run_sent")
            return {"ok": True, "dry_run": True}
        payload: dict[str, Any] = {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
        if reply_markup:
            payload["reply_markup"] = reply_markup
        try:
            resp = await self._client.post(f"{API}/bot{self.token}/sendMessage", json=payload)  # type: ignore[union-attr]
            resp.raise_for_status()
            METRICS.inc("telegram.sent")
            return resp.json()
        except httpx.HTTPError as exc:
            METRICS.inc("telegram.send_failed")
            log.error("telegram_send_failed", error=str(exc))
            return {"ok": False, "error": str(exc)}

    async def feedback_events(self) -> AsyncIterator[dict[str, Any]]:
        """Yield {'opportunity_id', 'status', 'from'} parsed from inline-button callbacks."""
        if self.dry_run:
            return
        while True:
            try:
                resp = await self._client.get(  # type: ignore[union-attr]
                    f"{API}/bot{self.token}/getUpdates",
                    params={"offset": self._offset + 1, "timeout": 25,
                            "allowed_updates": '["callback_query"]'},
                    timeout=35,
                )
                resp.raise_for_status()
                for upd in resp.json().get("result", []):
                    self._offset = max(self._offset, int(upd.get("update_id", 0)))
                    cq = upd.get("callback_query")
                    if not cq:
                        continue
                    data = str(cq.get("data", ""))
                    await self._answer_callback(cq.get("id"))
                    if data.startswith("fb:"):
                        _, opp_id, status = (data.split(":") + ["", ""])[:3]
                        yield {"opportunity_id": opp_id, "status": status,
                               "from": (cq.get("from") or {}).get("username")}
            except httpx.HTTPError as exc:
                log.warning("telegram_poll_failed", error=str(exc))
                await asyncio.sleep(5)

    async def _answer_callback(self, callback_id: str | None) -> None:
        if not callback_id or self.dry_run:
            return
        try:
            await self._client.post(  # type: ignore[union-attr]
                f"{API}/bot{self.token}/answerCallbackQuery",
                json={"callback_query_id": callback_id, "text": "Recorded ✔"},
            )
        except httpx.HTTPError:
            pass
