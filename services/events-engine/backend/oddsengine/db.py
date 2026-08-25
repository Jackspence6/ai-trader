"""Postgres/Timescale persistence layer + migration runner.

Durable storage for canonical data, odds time-series (Timescale hypertable),
opportunity lifecycles, alerts and placements. Hot state stays in Redis/memory;
everything here is append-mostly and rebuildable-from.

Runs fine on plain Postgres: migrations degrade gracefully when the timescaledb
extension is absent (odds_snapshots becomes a regular indexed table).

CLI:  python -m oddsengine.db --migrate
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

import asyncpg

from .models import Opportunity, Quote
from .observability import configure_logging, get_logger

log = get_logger("db")


def find_migrations_dir() -> Path | None:
    env = os.environ.get("ODDSENGINE_MIGRATIONS_DIR")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for parent in [Path.cwd(), *here.parents]:
        cand = parent / "db" / "migrations"
        if cand.is_dir():
            return cand
    return None


class Database:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    @classmethod
    async def connect(cls, db_url: str) -> Database:
        pool = await asyncpg.create_pool(db_url, min_size=1, max_size=8)
        return cls(pool)

    async def close(self) -> None:
        await self.pool.close()

    # ---------------------------------------------------------- migrations
    async def migrate(self, migrations_dir: Path | None = None) -> list[str]:
        mdir = migrations_dir or find_migrations_dir()
        if mdir is None:
            raise FileNotFoundError("db/migrations directory not found")
        async with self.pool.acquire() as conn:
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                " filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            applied = {r["filename"] for r in await conn.fetch("SELECT filename FROM schema_migrations")}
            ran = []
            for path in sorted(mdir.glob("*.sql")):
                if path.name in applied:
                    continue
                sql = path.read_text()
                async with conn.transaction():
                    await conn.execute(sql)
                    await conn.execute(
                        "INSERT INTO schema_migrations(filename) VALUES($1)", path.name)
                ran.append(path.name)
                log.info("migration_applied", filename=path.name)
            return ran

    # ----------------------------------------------------------- writes
    async def record_snapshot(self, q: Quote) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO odds_snapshots
                  (ts, ts_source, venue_id, event_id, market_key, outcome, decimal_odds,
                   raw_price, fee_rate, line, status, executable_zar, token_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                """,
                q.ts_ingest, q.ts_source, q.venue_id, q.event_id, q.market_key, q.outcome,
                q.odds_eff, q.raw_price, q.fee_rate, q.line, q.status.value,
                q.max_stake_zar, q.token_id,
            )

    async def record_opportunity(self, o: Opportunity) -> None:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO opportunities
                      (id, opp_type, event_id, event_label, sport, league, start_time, market_key,
                       margin_pct, score, score_breakdown, urgency, timing, rule_risk, mirrored,
                       total_stake_zar, guaranteed_profit_zar, executable_zar_per_leg, fx_rate,
                       first_seen, last_seen, peak_margin_pct, state, window_s, notes)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                            $20,$21,$22,$23,$24,$25)
                    ON CONFLICT (id) DO UPDATE SET
                       margin_pct=EXCLUDED.margin_pct, score=EXCLUDED.score,
                       score_breakdown=EXCLUDED.score_breakdown, last_seen=EXCLUDED.last_seen,
                       peak_margin_pct=EXCLUDED.peak_margin_pct, state=EXCLUDED.state,
                       window_s=EXCLUDED.window_s, total_stake_zar=EXCLUDED.total_stake_zar,
                       guaranteed_profit_zar=EXCLUDED.guaranteed_profit_zar,
                       executable_zar_per_leg=EXCLUDED.executable_zar_per_leg, notes=EXCLUDED.notes
                    """,
                    o.id, o.opp_type.value, o.event_id, o.event_label, o.sport.value, o.league,
                    o.start_time, o.market_key, o.margin_pct, o.score,
                    json.dumps(o.score_breakdown), o.urgency.value, o.timing.value, o.rule_risk,
                    o.mirrored, o.total_stake_zar, o.guaranteed_profit_zar,
                    None if o.executable_zar_per_leg == float("inf") else o.executable_zar_per_leg,
                    o.fx_rate, o.first_seen, o.last_seen, o.peak_margin_pct, o.state.value,
                    o.window_s, json.dumps(o.notes),
                )
                await conn.execute("DELETE FROM opportunity_legs WHERE opportunity_id=$1", o.id)
                for i, leg in enumerate(o.legs):
                    await conn.execute(
                        """
                        INSERT INTO opportunity_legs
                          (opportunity_id, idx, venue_id, outcome, selection_label, odds, raw_price,
                           fee_rate, stake_zar, deep_link, rules_group, is_pm, token_id,
                           max_stake_zar, order_index)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                        """,
                        o.id, i, leg.venue_id, leg.outcome, leg.selection_label, leg.odds,
                        leg.raw_price, leg.fee_rate, leg.stake_zar, leg.deep_link, leg.rules_group,
                        leg.is_pm, leg.token_id, leg.max_stake_zar, leg.order_index,
                    )

    async def record_lifecycle(self, opportunity_id: str, margin_pct: float, state: str,
                               note: str | None = None) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO opportunity_lifecycles(opportunity_id, margin_pct, state, note)"
                " VALUES ($1,$2,$3,$4)", opportunity_id, margin_pct, state, note)

    # ------------------------------------------------------- runtime flags
    async def get_flag(self, key: str) -> object | None:
        """Read a cross-process runtime flag (see db/migrations/004)."""
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow("SELECT value FROM runtime_flags WHERE key=$1", key)
        if row is None:
            return None
        raw = row["value"]
        return json.loads(raw) if isinstance(raw, str) else raw

    async def set_flag(self, key: str, value: object, updated_by: str = "engine") -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO runtime_flags(key, value, updated_at, updated_by)"
                " VALUES ($1, $2::jsonb, now(), $3)"
                " ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,"
                " updated_at=now(), updated_by=EXCLUDED.updated_by",
                key, json.dumps(value), updated_by)

    async def record_placement(self, opportunity_id: str, status: str, leg_idx: int | None,
                               actual_odds: float | None, actual_stake_zar: float | None,
                               note: str | None) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO placements(opportunity_id, status, leg_idx, actual_odds,"
                " actual_stake_zar, note) VALUES ($1,$2,$3,$4,$5,$6)",
                opportunity_id, status, leg_idx, actual_odds, actual_stake_zar, note)


async def _main() -> None:
    parser = argparse.ArgumentParser(description="OddsEngine DB tool")
    parser.add_argument("--migrate", action="store_true")
    parser.add_argument("--db-url", default=os.environ.get("DB_URL"))
    args = parser.parse_args()
    configure_logging()
    if not args.db_url:
        raise SystemExit("DB_URL not set")
    db = await Database.connect(args.db_url)
    try:
        if args.migrate:
            ran = await db.migrate()
            print(f"applied {len(ran)} migration(s): {ran}")
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(_main())
