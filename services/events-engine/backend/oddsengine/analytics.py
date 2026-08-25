"""Dry-run analytics + the go/no-go metric (spec §6).

Go/no-go over a 14-day dry run: >= 3 usable arbs/day at >= 1% margin with
>= R2,000 executable per leg, with window durations long enough for manual
placement. Capture rate (realized/theoretical) is the reality check.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any

from .models import Opportunity, PlacementFeedback

USABLE_MARGIN_PCT = 1.0
USABLE_EXEC_ZAR = 2000.0
TARGET_PER_DAY = 3.0
DRY_RUN_DAYS = 14


def _day(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def _quantiles(values: list[float]) -> dict[str, float]:
    if not values:
        return {"p25": 0.0, "p50": 0.0, "p75": 0.0, "p95": 0.0}
    v = sorted(values)
    q = lambda p: v[min(len(v) - 1, int(p * len(v)))]  # noqa: E731
    return {"p25": q(0.25), "p50": q(0.50), "p75": q(0.75), "p95": q(0.95)}


def _histogram(values: list[float], edges: list[float]) -> list[dict[str, Any]]:
    buckets = []
    for i in range(len(edges)):
        lo = edges[i]
        hi = edges[i + 1] if i + 1 < len(edges) else float("inf")
        count = sum(1 for v in values if lo <= v < hi)
        label = f"{lo:g}–{hi:g}" if hi != float("inf") else f"{lo:g}+"
        buckets.append({"bucket": label, "count": count})
    return buckets


def summarize(opportunities: list[Opportunity], placements: list[PlacementFeedback],
              window_samples: dict[str, list[float]] | None = None) -> dict[str, Any]:
    usable = [o for o in opportunities
              if o.margin_pct >= USABLE_MARGIN_PCT and o.executable_zar_per_leg >= USABLE_EXEC_ZAR]
    per_day: dict[str, int] = defaultdict(int)
    for o in usable:
        per_day[_day(o.first_seen)] += 1
    days_observed = max(len({_day(o.first_seen) for o in opportunities}), 1) if opportunities else 0
    usable_per_day = (len(usable) / days_observed) if days_observed else 0.0

    windows = [o.window_s for o in opportunities if o.window_s is not None]
    if window_samples:
        for vals in window_samples.values():
            windows.extend(v for v in vals if v is not None)

    placed_ids = {p.opportunity_id for p in placements if p.status == "placed"}
    alerted = [o for o in usable]
    capture_rate = (len(placed_ids & {o.id for o in alerted}) / len(alerted)) if alerted else 0.0

    theoretical = sum(o.guaranteed_profit_zar for o in usable)
    realized = 0.0
    opp_by_id = {o.id: o for o in opportunities}
    for p in placements:
        if p.status != "placed" or p.opportunity_id not in opp_by_id:
            continue
        opp = opp_by_id[p.opportunity_id]
        if p.actual_odds and p.actual_stake_zar and p.leg_idx is not None and opp.legs:
            # Leg-level capture: scale the theoretical profit by realized-vs-quoted odds drift.
            quoted = opp.legs[min(p.leg_idx, len(opp.legs) - 1)].odds
            drift = (p.actual_odds / quoted) if quoted else 1.0
            realized += opp.guaranteed_profit_zar * drift
        else:
            realized += opp.guaranteed_profit_zar

    go = (days_observed >= DRY_RUN_DAYS and usable_per_day >= TARGET_PER_DAY)
    verdict = "GO" if go else ("PENDING" if days_observed < DRY_RUN_DAYS else "NO-GO")

    return {
        "days_observed": days_observed,
        "opportunities_total": len(opportunities),
        "usable_total": len(usable),
        "usable_per_day": round(usable_per_day, 2),
        "target_per_day": TARGET_PER_DAY,
        "dry_run_days_target": DRY_RUN_DAYS,
        "go_no_go": verdict,
        "margin_pct": _quantiles([o.margin_pct for o in opportunities]),
        "margin_histogram": _histogram([o.margin_pct for o in opportunities],
                                       [0, 0.5, 1, 1.5, 2, 3, 5, 8]),
        "window_s": _quantiles(windows),
        "window_histogram": _histogram(windows, [0, 5, 15, 30, 60, 120, 300, 600]),
        "executable_zar": _quantiles([o.executable_zar_per_leg for o in opportunities
                                      if o.executable_zar_per_leg != float("inf")]),
        "capture_rate": round(capture_rate, 3),
        "theoretical_profit_zar": round(theoretical, 2),
        "realized_profit_zar": round(realized, 2),
        "by_type": {t: sum(1 for o in opportunities if o.opp_type.value == t)
                    for t in {o.opp_type.value for o in opportunities}},
        "by_day": dict(sorted(per_day.items())),
        "placements": {s: sum(1 for p in placements if p.status == s)
                       for s in {"placed", "missed", "voided", "partial"}},
    }
