"""Config loading: YAML files (config/engine.yaml + config/venues.yaml) with env overrides.

Env overrides (secrets never live in YAML):
    ODDSENGINE_CONFIG_DIR, STATE_BACKEND, DB_URL, REDIS_URL,
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, TELEGRAM_OPS_CHANNEL_ID,
    ODDSENGINE_DRY_RUN, ODDSENGINE_KILL_SWITCH
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class EngineConfig(BaseModel):
    min_margin_pct: float = 1.0
    min_executable_zar: float = 2000.0
    kelly_fraction: float = 0.25            # applied to sizing when residual risk (rule risk) exists
    max_exposure_zar_per_event: float = 20000.0
    max_exposure_zar_daily: float = 100000.0
    max_usd_exposure: float = 2000.0
    total_stake_default_zar: float = 10000.0
    stake_rounding_zar: list[float] = Field(default_factory=lambda: [50.0, 10.0])  # try 50 then 10
    same_venue_arbs: bool = True            # emit but heavily penalize (palpable-error risk)


class ScoringWeights(BaseModel):
    margin: float = 0.30
    executable_size: float = 0.15
    window_duration: float = 0.15
    venue_softness: float = 0.10
    rule_risk: float = 0.10
    account_safety: float = 0.10
    fx_risk: float = 0.05
    resolution_risk: float = 0.05


class PollingConfig(BaseModel):
    default_interval_s: float = 20.0
    near_kickoff_interval_s: float = 5.0
    near_kickoff_window_min: float = 60.0
    jitter_frac: float = 0.25


class StalenessConfig(BaseModel):
    max_age_factor: float = 2.5      # quote stale if older than factor * venue polling interval
    sweep_interval_s: float = 10.0
    frozen_peer_moves: int = 5       # venue frozen while peers moved N times -> degrade health


class PolymarketConfig(BaseModel):
    gamma_url: str = "https://gamma-api.polymarket.com"
    clob_url: str = "https://clob.polymarket.com"
    ws_url: str = "wss://ws-subscriptions-clob.polymarket.com/ws/"
    read_fee_rate_live: bool = True
    # Fallback taker fee table (2026); the live /fee-rate endpoint is the source of truth.
    fee_fallback_by_category: dict[str, float] = Field(
        default_factory=lambda: {
            "crypto": 0.07,
            "sports": 0.05,
            "finance": 0.04,
            "politics": 0.04,
            "mentions": 0.04,
            "tech": 0.04,
            "economics": 0.05,
            "culture": 0.05,
            "weather": 0.05,
            "geopolitics": 0.0,
            "other": 0.05,
        }
    )
    sports_tags: list[str] = Field(default_factory=lambda: ["sports", "nba", "nfl", "soccer", "epl", "tennis"])
    slippage_bps: float = 50.0       # depth walk bound when computing executable size


class FxConfig(BaseModel):
    pair: str = "USDZAR"
    buffer_pct: float = 2.0
    fallback_rate: float = 18.0      # used only when no live rate is available; overridden at runtime
    refresh_s: float = 60.0
    provider_url: str = "https://open.er-api.com/v6/latest/USD"


class MatchingConfig(BaseModel):
    auto_accept: float = 0.92
    review_min: float = 0.75
    start_tolerance_min: float = 15.0
    pm_start_tolerance_min: float = 240.0   # PM markets are often date-bracketed


class AlertsConfig(BaseModel):
    telegram_bot_token: str | None = None       # from env
    telegram_channel_id: str | None = None
    telegram_ops_channel_id: str | None = None
    dry_run: bool = True                        # Phase 1 default: log alerts, don't require Telegram
    min_score: float = 0.0
    resend_margin_improvement_pp: float = 0.5


class WindowPriors(BaseModel):
    """Heuristic expected window (seconds) until survival models are fitted (Section 13)."""

    pre_match: float = 600.0
    near_kickoff: float = 120.0
    live: float = 4.0   # ~3.6s median in-game (arXiv 2605.00864) — measure-only


class AppConfig(BaseModel):
    engine: EngineConfig = Field(default_factory=EngineConfig)
    scoring_weights: ScoringWeights = Field(default_factory=ScoringWeights)
    polling: PollingConfig = Field(default_factory=PollingConfig)
    staleness: StalenessConfig = Field(default_factory=StalenessConfig)
    polymarket: PolymarketConfig = Field(default_factory=PolymarketConfig)
    fx: FxConfig = Field(default_factory=FxConfig)
    matching: MatchingConfig = Field(default_factory=MatchingConfig)
    alerts: AlertsConfig = Field(default_factory=AlertsConfig)
    window_priors: WindowPriors = Field(default_factory=WindowPriors)
    kill_switch: bool = False
    state_backend: str = "memory"               # memory | redis
    db_url: str | None = None
    redis_url: str = "redis://localhost:6379/0"
    log_level: str = "INFO"
    venues: dict[str, dict[str, Any]] = Field(default_factory=dict)


def _find_config_dir() -> Path | None:
    env = os.environ.get("ODDSENGINE_CONFIG_DIR")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for parent in [Path.cwd(), *here.parents]:
        cand = parent / "config"
        if (cand / "engine.yaml").exists():
            return cand
    return None


def load_config(config_dir: str | Path | None = None) -> AppConfig:
    cdir = Path(config_dir) if config_dir else _find_config_dir()
    data: dict[str, Any] = {}
    if cdir and (cdir / "engine.yaml").exists():
        data = yaml.safe_load((cdir / "engine.yaml").read_text()) or {}
    if cdir and (cdir / "venues.yaml").exists():
        vdata = yaml.safe_load((cdir / "venues.yaml").read_text()) or {}
        data["venues"] = vdata.get("venues", {})

    cfg = AppConfig.model_validate(data)

    # Env overrides
    if v := os.environ.get("STATE_BACKEND"):
        cfg.state_backend = v
    if v := os.environ.get("DB_URL"):
        cfg.db_url = v
    if v := os.environ.get("REDIS_URL"):
        cfg.redis_url = v
    if v := os.environ.get("TELEGRAM_BOT_TOKEN"):
        cfg.alerts.telegram_bot_token = v
    if v := os.environ.get("TELEGRAM_CHANNEL_ID"):
        cfg.alerts.telegram_channel_id = v
    if v := os.environ.get("TELEGRAM_OPS_CHANNEL_ID"):
        cfg.alerts.telegram_ops_channel_id = v
    if v := os.environ.get("ODDSENGINE_DRY_RUN"):
        cfg.alerts.dry_run = v.lower() in ("1", "true", "yes")
    if v := os.environ.get("ODDSENGINE_KILL_SWITCH"):
        cfg.kill_switch = v.lower() in ("1", "true", "yes")
    return cfg
