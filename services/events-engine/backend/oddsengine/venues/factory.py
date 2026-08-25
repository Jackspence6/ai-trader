"""Build venue adapters from config/venues.yaml."""

from __future__ import annotations

from typing import Any

from ..config import AppConfig
from ..observability import get_logger
from .base import VenueAdapter
from .betway import BetwaySAAdapter
from .hollywoodbets import HollywoodbetsAdapter
from .polymarket import PolymarketAdapter
from .sunbet import SunbetAdapter
from .supabets import SupabetsAdapter

log = get_logger("venues.factory")

BOOKIE_CLASSES = {
    "betway_sa": BetwaySAAdapter,
    "hollywoodbets": HollywoodbetsAdapter,
    "supabets": SupabetsAdapter,
    "sunbet": SunbetAdapter,
}


def build_adapters(cfg: AppConfig, only: list[str] | None = None) -> dict[str, VenueAdapter]:
    adapters: dict[str, VenueAdapter] = {}
    for venue_id, vcfg in (cfg.venues or {}).items():
        if only and venue_id not in only:
            continue
        try:
            adapters[venue_id] = _build_one(cfg, venue_id, vcfg or {})
        except Exception as exc:  # noqa: BLE001
            log.error("adapter_build_failed", venue=venue_id, error=str(exc))
    return adapters


def _build_one(cfg: AppConfig, venue_id: str, vcfg: dict[str, Any]) -> VenueAdapter:
    if venue_id == "polymarket":
        return PolymarketAdapter(cfg.polymarket)
    cls = BOOKIE_CLASSES.get(venue_id)
    if cls is None:
        raise ValueError(f"unknown venue '{venue_id}' — add its adapter class to factory.BOOKIE_CLASSES")
    adapter = cls(
        endpoints=vcfg.get("endpoints") or {},
        enabled=bool(vcfg.get("enabled", False)),
        softness=float(vcfg.get("softness", 0.5)),
        max_stake_default=float(vcfg.get("max_stake_default_zar", 20000.0)),
    )
    if vcfg.get("min_interval_s") is not None:
        adapter.meta.min_interval_s = float(vcfg["min_interval_s"])
    if vcfg.get("deep_link_template"):
        adapter.meta.deep_link_template = vcfg["deep_link_template"]
    return adapter
