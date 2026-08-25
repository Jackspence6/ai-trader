"""Go/no-go report generator (spec §6, M6).

    python -m oddsengine.report [runs/demo_run.json] [--out report.md]

Reads a dry-run export (state.export_json) and renders the decision report:
usable arbs/day vs the ≥3/day @ ≥1% @ ≥R2,000/leg threshold, window-duration
distribution (manual-placement feasibility), capture rate, realized vs theoretical.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .analytics import DRY_RUN_DAYS, TARGET_PER_DAY, summarize
from .models import Opportunity, PlacementFeedback


def load_export(path: str | Path) -> tuple[list[Opportunity], list[PlacementFeedback], dict]:
    data = json.loads(Path(path).read_text())
    opps = [Opportunity.model_validate(o) for o in data.get("opportunities", [])]
    placements = [PlacementFeedback.model_validate(p) for p in data.get("placements", [])]
    return opps, placements, data.get("window_samples", {})


def render_markdown(summary: dict) -> str:
    s = summary
    lines = [
        "# OddsEngine — dry-run go/no-go report",
        "",
        f"**Verdict: {s['go_no_go']}**  ·  days observed: {s['days_observed']} / {DRY_RUN_DAYS}",
        "",
        "## The metric",
        f"Target: ≥{TARGET_PER_DAY:g} usable arbs/day at ≥1% margin with ≥R2,000 executable/leg, "
        "with windows long enough for manual placement.",
        "",
        f"- Usable arbs total: **{s['usable_total']}** ({s['usable_per_day']}/day)",
        f"- All opportunities measured: {s['opportunities_total']}",
        f"- By type: {s['by_type']}",
        "",
        "## Margins (fee/FX-adjusted, %)",
        f"- p25 {s['margin_pct']['p25']:.2f} · p50 {s['margin_pct']['p50']:.2f} · "
        f"p75 {s['margin_pct']['p75']:.2f} · p95 {s['margin_pct']['p95']:.2f}",
        "",
        "## Window durations (seconds)",
        f"- p25 {s['window_s']['p25']:.1f} · p50 {s['window_s']['p50']:.1f} · "
        f"p75 {s['window_s']['p75']:.1f} · p95 {s['window_s']['p95']:.1f}",
        "- Distribution: " + ", ".join(f"{b['bucket']}s: {b['count']}" for b in s["window_histogram"]),
        "",
        "## Executable size (ZAR/leg)",
        f"- p25 {s['executable_zar']['p25']:,.0f} · p50 {s['executable_zar']['p50']:,.0f} · "
        f"p95 {s['executable_zar']['p95']:,.0f}",
        "",
        "## Execution reality check",
        f"- Capture rate (placed/usable): **{s['capture_rate']:.0%}**",
        f"- Theoretical locked profit: R{s['theoretical_profit_zar']:,.2f}",
        f"- Realized (from feedback): R{s['realized_profit_zar']:,.2f}",
        f"- Feedback: {s['placements']}",
        "",
        "## Decision guide (spec §12 recommendations)",
        "- **GO** → onboard remaining SA books (M7) and build Phase 2 accounts/promos.",
        "- **NO-GO** → in order: (a) windows too short → weight pre-match/outrights/promo boosts; "
        "(b) size capped → adjust `min_executable_zar`; (c) too few matched events → widen leagues "
        "+ improve fuzzy matching. Capture rate <30% → deprioritize live arbs, lean on Phase-2 "
        "promo/rollover hedging.",
        "",
        "## Per-day usable counts",
    ]
    for day, count in s.get("by_day", {}).items():
        lines.append(f"- {day}: {count}")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="OddsEngine go/no-go report")
    parser.add_argument("export", nargs="?", default="runs/demo_run.json")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    opps, placements, windows = load_export(args.export)
    summary = summarize(opps, placements, windows)
    md = render_markdown(summary)
    if args.out:
        Path(args.out).write_text(md)
        print(f"report written -> {args.out}")
    else:
        print(md)


if __name__ == "__main__":
    main()
