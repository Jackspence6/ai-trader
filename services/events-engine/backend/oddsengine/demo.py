"""End-to-end dry-run demo — runs the real pipeline on scripted mock venues.

    python -m oddsengine.demo          (or: make demo)

Reproduces the spec §14.1 worked examples through mock venues -> normalizer ->
engine -> alerter (dry-run Telegram), prints every alert, then a lifecycle +
analytics summary, and exports runs/demo_run.json for `python -m oddsengine.report`.
No Docker, DB, Redis or network required.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from .analytics import summarize
from .bus import MemoryBus
from .config import load_config
from .models import Opportunity
from .observability import configure_logging
from .services.alerter import Alerter
from .simulation import build_world, ingest_catalogue, run_tick, script_timeline, seed_fixtures
from .state import MemoryState

TICK_NARRATION = {
    0: "baseline odds — no arbs anywhere",
    1: "1X2 arb appears: 2.40 / 3.80 / 3.50 across three books (§14.1 → 3.44%)",
    2: "tennis 2.10 / 2.05 — but retirement rules DIFFER (rule-risk, not pure)",
    3: "same-rules book posts 2.06 — clean pure arb replaces the rule-risk one",
    4: "Polymarket YES 0.50 (sports fee 5%) vs bookie 2.10 (§14.1 → ~1.1%)",
    5: "PM-internal YES 0.48 + NO 0.50: fees push cost to 1.005 — correctly NOT flagged",
    6: "negRisk full set 0.30/0.32/0.33 @ 4% fee — internal arb ~2.4%",
    7: "books move away — opportunities expire, windows measured",
}


async def run_demo(out_path: str | Path = "runs/demo_run.json", tick_sleep: float = 0.4,
                   db_url: str | None = None) -> dict:
    """Run the scripted scenario end to end.

    Pass db_url (or set DB_URL) to also persist every opportunity, leg and odds
    snapshot — that seeds a Postgres/Neon database the hosted dashboard reads, so
    the deployment has real engine output in it before live ingestion starts.
    """
    cfg = load_config()
    state = MemoryState()
    bus = MemoryBus()

    db = None
    db_url = db_url or os.environ.get("DB_URL") or os.environ.get("DATABASE_URL")
    if db_url:
        from .db import Database
        db = await Database.connect(db_url)
        applied = await db.migrate()
        print(f"database connected — migrations applied: {applied or 'already up to date'}")

    world = build_world(cfg, state, bus, db)
    seed_fixtures(world)
    script_timeline(world)

    alerter = Alerter(cfg, state, bus)
    alerts_out: list[str] = []

    async def collect_alerts() -> None:
        async for payload in bus.subscribe("alerts"):
            text = await alerter.handle_alert(payload)
            alerts_out.append(text)
            print("\n┌─ TELEGRAM ALERT " + "─" * 44)
            for line in text.splitlines():
                print("│ " + line)
            print("└" + "─" * 61)

    collector = asyncio.create_task(collect_alerts())

    await ingest_catalogue(world)
    print(f"\nOddsEngine demo — {len(world.registry.events)} canonical events matched "
          f"across {len(world.venues)} venues\n" + "=" * 62)

    for tick in sorted(TICK_NARRATION):
        print(f"\n[t{tick}] {TICK_NARRATION[tick]}")
        emitted = await run_tick(world, tick)
        await asyncio.sleep(tick_sleep)  # let alerts drain; gives visible window durations
        for opp in emitted:
            flag = "RULE-RISK" if opp.rule_risk else "pure"
            print(f"      -> {opp.opp_type.value}  margin {opp.margin_pct:.2f}%  "
                  f"score {opp.score:g}  [{flag}]  exec R{opp.executable_zar_per_leg:,.0f}/leg")

    await asyncio.sleep(0.2)
    collector.cancel()

    opps = await state.all_opportunities()
    summary = summarize(opps, await state.get_placements(), dict(state.window_samples))
    print("\n" + "=" * 62)
    print("DRY-RUN SUMMARY")
    print(f"  opportunities detected : {summary['opportunities_total']}")
    print(f"  usable (≥1% & ≥R2k)    : {summary['usable_total']}")
    print(f"  by type                : {summary['by_type']}")
    print(f"  margin p50/p95         : {summary['margin_pct']['p50']:.2f}% / "
          f"{summary['margin_pct']['p95']:.2f}%")
    print(f"  window p50             : {summary['window_s']['p50']:.1f}s (simulated ticks)")
    print(f"  alerts sent (dry-run)  : {len(alerts_out)}")
    print(f"  go/no-go               : {summary['go_no_go']} "
          f"(needs {summary['dry_run_days_target']} days of real ingestion)")

    if db is not None:
        await db.close()
        print("  persisted to database  : yes")

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    await state.export_json(out)
    print(f"\nExported dry-run dataset -> {out}")
    print("Run `python -m oddsengine.report runs/demo_run.json` for the go/no-go report.")
    return summary


def _expected_examples(opps: list[Opportunity]) -> dict[str, bool]:
    """Used by tests: verify the §14.1 examples all materialized."""
    def has(pred) -> bool:
        return any(pred(o) for o in opps)

    return {
        "three_way_344": has(lambda o: o.market_key.startswith("1X2") and abs(o.margin_pct - 3.44) < 0.1),
        "tennis_rule_risk_then_clean": has(lambda o: o.market_key.startswith("MONEYLINE") and o.rule_risk)
        and has(lambda o: o.market_key.startswith("MONEYLINE") and not o.rule_risk
                and o.sport.value == "tennis"),
        "bookie_vs_pm_11": has(lambda o: o.opp_type.value == "bookie_vs_polymarket"
                               and 0.8 < o.margin_pct < 1.5),
        "negrisk_24": has(lambda o: o.market_key.startswith("NEGRISK") and 2.0 < o.margin_pct < 3.0),
        "fee_killed_absent": not has(lambda o: "pm-mention" in o.market_key),
    }


if __name__ == "__main__":
    configure_logging(level="WARNING")  # keep demo stdout readable; alerts print directly
    asyncio.run(run_demo())
