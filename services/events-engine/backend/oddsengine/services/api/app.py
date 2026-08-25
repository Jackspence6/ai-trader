"""FastAPI service: REST + WebSocket feed for the dashboard (spec §2, §9).

Run standalone (Compose):  uvicorn oddsengine.services.api.app:app
Embedded (dev/demo):        create_app(cfg, state, bus, registry)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ... import __version__
from ...analytics import summarize
from ...bus import make_bus
from ...config import AppConfig, load_config
from ...matching import CanonicalRegistry
from ...models import OppState, PlacementFeedback
from ...observability import METRICS, get_logger
from ...state import make_state

log = get_logger("api")


class FeedbackIn(BaseModel):
    opportunity_id: str
    status: str
    leg_idx: int | None = None
    actual_odds: float | None = None
    actual_stake_zar: float | None = None
    note: str | None = None


class KillSwitchIn(BaseModel):
    on: bool


class ReviewIn(BaseModel):
    accept: bool
    edited: str | None = None


def create_app(cfg: AppConfig | None = None, state=None, bus=None,
               registry: CanonicalRegistry | None = None, db=None) -> FastAPI:
    cfg = cfg or load_config()
    state = state if state is not None else make_state(cfg.state_backend, cfg.redis_url)
    bus = bus if bus is not None else make_bus(cfg.state_backend, cfg.redis_url)
    registry = registry or CanonicalRegistry()

    app = FastAPI(title="OddsEngine API", version=__version__)
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    )
    app.state.cfg, app.state.hot, app.state.bus, app.state.registry = cfg, state, bus, registry

    # ------------------------------------------------------------- basic
    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "kill_switch": await state.get_kill_switch()}

    @app.get("/metrics")
    async def metrics() -> dict[str, Any]:
        return METRICS.snapshot()

    @app.get("/config")
    async def config() -> dict[str, Any]:
        data = cfg.model_dump()
        data["alerts"].pop("telegram_bot_token", None)   # never leak secrets
        data.pop("db_url", None)
        return data

    # ----------------------------------------------------- opportunities
    @app.get("/opportunities")
    async def opportunities(state_filter: str = "active", limit: int = 200) -> list[dict]:
        opps = (await state.active_opportunities() if state_filter == "active"
                else await state.all_opportunities())
        opps.sort(key=lambda o: (o.state != OppState.ACTIVE, -o.score))
        return [o.model_dump(mode="json") for o in opps[:limit]]

    @app.get("/opportunities/{opp_id}")
    async def opportunity(opp_id: str) -> dict:
        opp = await state.get_opportunity(opp_id)
        if opp is None:
            raise HTTPException(404, "unknown opportunity")
        return opp.model_dump(mode="json")

    # ------------------------------------------------------------ venues
    @app.get("/venues/health")
    async def venues_health() -> dict[str, Any]:
        return {k: v.model_dump(mode="json") for k, v in (await state.get_health()).items()}

    # ------------------------------------------------------------ reviews
    @app.get("/reviews")
    async def reviews() -> list[dict]:
        return [r.__dict__ for r in registry.pending_reviews()]

    @app.post("/reviews/{review_id}")
    async def resolve_review(review_id: str, body: ReviewIn) -> dict:
        item = registry.resolve_review(review_id, body.accept, body.edited)
        if item is None:
            raise HTTPException(404, "unknown review")
        return {"id": item.id, "status": item.status}

    # ---------------------------------------------------------- analytics
    @app.get("/analytics/summary")
    async def analytics_summary() -> dict[str, Any]:
        opps = await state.all_opportunities()
        placements = await state.get_placements()
        windows = getattr(state, "window_samples", None)
        return summarize(opps, placements, dict(windows) if windows else None)

    # ----------------------------------------------------------- feedback
    @app.post("/feedback")
    async def feedback(body: FeedbackIn) -> dict:
        fb = PlacementFeedback(**body.model_dump())
        await state.add_placement(fb)
        if db is not None:
            await db.record_placement(fb.opportunity_id, fb.status, fb.leg_idx,
                                      fb.actual_odds, fb.actual_stake_zar, fb.note)
        METRICS.inc(f"api.feedback_{fb.status}")
        return {"ok": True}

    # -------------------------------------------------------- kill switch
    @app.post("/killswitch")
    async def killswitch(body: KillSwitchIn) -> dict:
        await state.set_kill_switch(body.on)
        log.warning("kill_switch_set", on=body.on)
        return {"ok": True, "kill_switch": body.on}

    # ------------------------------------------------------------- stream
    @app.websocket("/ws/opportunities")
    async def ws_opportunities(ws: WebSocket) -> None:
        await ws.accept()
        try:
            snapshot = [o.model_dump(mode="json") for o in await state.active_opportunities()]
            await ws.send_text(json.dumps({"type": "snapshot", "opportunities": snapshot}, default=str))

            async def _pump() -> None:
                async for payload in bus.subscribe("opportunities"):
                    await ws.send_text(json.dumps({"type": "opportunity", "opportunity": payload},
                                                  default=str))

            pump = asyncio.create_task(_pump())
            try:
                while True:
                    await ws.receive_text()   # keepalive / ignore client messages
            finally:
                pump.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pump
        except WebSocketDisconnect:
            return

    return app


app = create_app()
