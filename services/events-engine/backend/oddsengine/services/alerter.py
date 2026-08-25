"""Alerter service: alerts topic -> Telegram (+ dry-run log) + feedback intake +
ops-channel scraper-health alerts (spec §6, §10)."""

from __future__ import annotations

import asyncio
import time

from ..alerts.telegram import TelegramClient
from ..alerts.templates import format_alert, inline_keyboard
from ..config import AppConfig
from ..models import Opportunity, PlacementFeedback
from ..observability import METRICS, get_logger

log = get_logger("alerter")

OPS_ALERT_COOLDOWN_S = 600.0


class Alerter:
    def __init__(self, cfg: AppConfig, state, bus, dashboard_url: str | None = None) -> None:
        self.cfg = cfg
        self.state = state
        self.bus = bus
        self.dashboard_url = dashboard_url or "http://localhost:3000"
        self.tg = TelegramClient(cfg.alerts.telegram_bot_token, dry_run=cfg.alerts.dry_run)
        self._ops_last_sent: dict[str, float] = {}

    async def handle_alert(self, payload: dict) -> str:
        opp = Opportunity.model_validate(payload["opportunity"])
        text = format_alert(opp)
        kb = inline_keyboard(opp, self.dashboard_url)
        result = await self.tg.send(self.cfg.alerts.telegram_channel_id or "", text, kb)
        await self.state.log_alert({
            "opportunity_id": opp.id, "kind": payload.get("kind", "new"), "channel": "telegram",
            "ok": bool(result.get("ok")), "dry_run": bool(result.get("dry_run")),
            "text": text, "ts": opp.last_seen.isoformat(),
        })
        METRICS.inc("alerter.alerts_handled")
        return text

    async def handle_health(self, payload: dict) -> None:
        state = payload.get("state")
        venue = payload.get("venue_id", "?")
        if state not in ("stale", "quarantined", "degraded"):
            return
        now = time.time()
        if now - self._ops_last_sent.get(venue, 0.0) < OPS_ALERT_COOLDOWN_S:
            return
        self._ops_last_sent[venue] = now
        note = payload.get("note") or ""
        text = (f"⚙️ OPS: adapter '{venue}' is {state.upper()}"
                f" (errors={payload.get('error_rate')}, staleness={payload.get('staleness_s')}s). {note}")
        chat = self.cfg.alerts.telegram_ops_channel_id or self.cfg.alerts.telegram_channel_id or ""
        await self.tg.send(chat, text)

    async def handle_feedback(self, fb: PlacementFeedback) -> None:
        await self.state.add_placement(fb)
        METRICS.inc(f"alerter.feedback_{fb.status}")
        log.info("feedback_recorded", opportunity_id=fb.opportunity_id, status=fb.status)

    async def run(self) -> None:
        async def _alerts() -> None:
            async for payload in self.bus.subscribe("alerts"):
                try:
                    await self.handle_alert(payload)
                except Exception as exc:  # noqa: BLE001
                    log.error("alert_failed", error=str(exc))

        async def _health() -> None:
            async for payload in self.bus.subscribe("health"):
                await self.handle_health(payload)

        async def _feedback() -> None:
            async for ev in self.tg.feedback_events():
                await self.handle_feedback(PlacementFeedback(
                    opportunity_id=ev["opportunity_id"], status=ev["status"], note=ev.get("from"),
                ))

        await asyncio.gather(_alerts(), _health(), _feedback())
