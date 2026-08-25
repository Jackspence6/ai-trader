"""Shared simulated-venue scenario used by the demo (scripted, assertable) and the
dev server (continuous random walk feeding the dashboard).

Recreates the spec §14.1 worked examples end-to-end through the real pipeline:
mock venues -> normalizer -> engine -> alerter, no external services required.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from .config import AppConfig
from .fx import FxService
from .matching import CanonicalRegistry, EventMatcher
from .models import MarketType, RawMarket, RawSelection, Sport, VenueKind, utcnow
from .rules import VenueRulesProfile
from .services.engine import ArbEngine
from .services.normalizer import Normalizer
from .venues.mock import MockFixture, MockVenue, ScriptedUpdate

PM = "polymarket"


@dataclass
class SimWorld:
    cfg: AppConfig
    state: object
    bus: object
    fx: FxService
    registry: CanonicalRegistry
    matcher: EventMatcher
    normalizer: Normalizer
    engine: ArbEngine
    venues: dict[str, MockVenue]


def build_world(cfg: AppConfig, state, bus, db=None) -> SimWorld:
    fx = FxService(cfg.fx)
    fx.set_rate(18.00, live=False)  # deterministic demo rate; runtime uses live refresh

    registry = CanonicalRegistry()
    matcher = EventMatcher(registry, cfg.matching)

    beta = MockVenue("betmock_a", "MockBet Alpha", softness=0.75,
                     rules=VenueRulesProfile(venue_id="betmock_a", tennis_retirement="BALL_SERVED",
                                             soccer_duration="REG_90", basketball_ot="INCLUDED"))
    bravo = MockVenue("betmock_b", "MockBet Bravo", softness=0.55,
                      rules=VenueRulesProfile(venue_id="betmock_b", tennis_retirement="BALL_SERVED",
                                              soccer_duration="REG_90", basketball_ot="INCLUDED"))
    charlie = MockVenue("betmock_c", "MockBet Charlie", softness=0.45,
                        rules=VenueRulesProfile(venue_id="betmock_c",
                                                tennis_retirement="MATCH_COMPLETED",
                                                soccer_duration="REG_90", basketball_ot="INCLUDED"))
    pm = MockVenue(PM, "Polymarket", kind=VenueKind.PREDICTION_MARKET, softness=0.10,
                   rules=VenueRulesProfile(venue_id=PM, tennis_retirement="PER_MARKET",
                                           soccer_duration="PER_MARKET", basketball_ot="PER_MARKET"))
    venues: dict[str, MockVenue] = {v.meta.venue_id: v for v in (beta, bravo, charlie, pm)}

    normalizer = Normalizer(cfg, registry, matcher, venues, state, bus, fx, db)
    engine = ArbEngine(cfg, state, bus, fx, venues, registry, db)
    return SimWorld(cfg, state, bus, fx, registry, matcher, normalizer, engine, venues)


def seed_fixtures(world: SimWorld) -> None:
    now = utcnow()
    beta, bravo, charlie, pm = (world.venues[k] for k in ("betmock_a", "betmock_b", "betmock_c", PM))

    # --- PSL soccer 1X2 (3-way §14.1) --------------------------------------
    for v, ref in ((beta, "a-psl1"), (bravo, "b-psl1"), (charlie, "c-psl1")):
        v.add_fixture(MockFixture(ref=ref, sport=Sport.SOCCER, league="Betway Premiership",
                                  home="Mamelodi Sundowns", away="Orlando Pirates",
                                  start_time=now + timedelta(hours=3)))
        v.add_market(ref, f"{ref}-1x2", MarketType.X12,
                     [(f"{ref}-h", "Mamelodi Sundowns"), (f"{ref}-d", "Draw"),
                      (f"{ref}-a", "Orlando Pirates")])

    # --- WTA tennis 2-way (§14.1) ------------------------------------------
    for v, ref in ((beta, "a-wta1"), (bravo, "b-wta1"), (charlie, "c-wta1")):
        v.add_fixture(MockFixture(ref=ref, sport=Sport.TENNIS, league="WTA",
                                  home="Kasatkina", away="Fernandez",
                                  start_time=now + timedelta(hours=2)))
        v.add_market(ref, f"{ref}-ml", MarketType.MONEYLINE_2WAY,
                     [(f"{ref}-p1", "Kasatkina"), (f"{ref}-p2", "Fernandez")])

    # --- NBA moneyline: bookie vs Polymarket (§14.1) -----------------------
    beta.add_fixture(MockFixture(ref="a-nba1", sport=Sport.BASKETBALL, league="NBA",
                                 home="Los Angeles Lakers", away="Boston Celtics",
                                 start_time=now + timedelta(hours=1)))
    beta.add_market("a-nba1", "a-nba1-ml", MarketType.MONEYLINE_2WAY,
                    [("a-nba1-h", "Lakers"), ("a-nba1-a", "Celtics")])
    pm.add_fixture(MockFixture(ref="pm-nba1", sport=Sport.BASKETBALL, league="NBA",
                               home="Los Angeles Lakers", away="Boston Celtics",
                               start_time=now + timedelta(hours=1)))
    pm_market = RawMarket(
        venue_id=PM, event_ref="pm-nba1", ref="pm-nba1-will-lakers",
        market_type=MarketType.BINARY_YESNO,
        market_type_raw="Will the Lakers beat the Celtics?",
        selections=[RawSelection(ref="tok-lal-yes", name_raw="Yes"),
                    RawSelection(ref="tok-lal-no", name_raw="No")],
    )
    pm.fixtures["pm-nba1"].markets.append(pm_market)

    # --- PM-internal binary (fees kill it — §14.1 example 4) ---------------
    pm.add_fixture(MockFixture(ref="pm-mention", sport=Sport.OTHER, league="Mentions",
                               home="Thing", away="Happens",
                               start_time=now + timedelta(days=2)))
    pm.fixtures["pm-mention"].markets.append(RawMarket(
        venue_id=PM, event_ref="pm-mention", ref="pm-mention-q",
        market_type=MarketType.BINARY_YESNO, market_type_raw="Will the thing happen?",
        selections=[RawSelection(ref="tok-th-yes", name_raw="Yes"),
                    RawSelection(ref="tok-th-no", name_raw="No")],
    ))

    # --- PM negRisk 3-outcome set (internal full-set arb) ------------------
    pm.add_fixture(MockFixture(ref="pm-jhb-mayor", sport=Sport.OTHER, league="Politics",
                               home="JHB", away="Mayor",
                               start_time=now + timedelta(days=30)))
    for i, cand in enumerate(("Candidate A", "Candidate B", "Candidate C")):
        pm.fixtures["pm-jhb-mayor"].markets.append(RawMarket(
            venue_id=PM, event_ref="pm-jhb-mayor", ref=f"pm-mayor-{i}",
            market_type=MarketType.NEGRISK_MULTI, market_type_raw=f"Will {cand} be next JHB mayor?",
            selections=[RawSelection(ref=f"tok-mayor-{i}-yes", name_raw="Yes")],
            neg_risk_group="pm-jhb-mayor", neg_risk_complete=True, neg_risk_size=3,
        ))


def script_timeline(world: SimWorld) -> None:
    """Scripted ticks reproducing the §14.1 examples (t indices documented per tick)."""
    beta, bravo, charlie, pm = (world.venues[k] for k in ("betmock_a", "betmock_b", "betmock_c", PM))
    S = ScriptedUpdate

    # t0 — baseline, no arbs anywhere
    for v, ref in ((beta, "a-psl1"), (bravo, "b-psl1"), (charlie, "c-psl1")):
        v.script_update(S(0, ref, f"{ref}-1x2", f"{ref}-h", decimal_odds=2.20))
        v.script_update(S(0, ref, f"{ref}-1x2", f"{ref}-d", decimal_odds=3.40))
        v.script_update(S(0, ref, f"{ref}-1x2", f"{ref}-a", decimal_odds=3.20))
    for v, ref in ((beta, "a-wta1"), (bravo, "b-wta1"), (charlie, "c-wta1")):
        v.script_update(S(0, ref, f"{ref}-ml", f"{ref}-p1", decimal_odds=1.85))
        v.script_update(S(0, ref, f"{ref}-ml", f"{ref}-p2", decimal_odds=1.85))

    # t1 — 3-way 1X2 arb (§14.1: 2.40 / 3.80 / 3.50 -> 3.44%)
    beta.script_update(S(1, "a-psl1", "a-psl1-1x2", "a-psl1-h", decimal_odds=2.40))
    bravo.script_update(S(1, "b-psl1", "b-psl1-1x2", "b-psl1-d", decimal_odds=3.80))
    charlie.script_update(S(1, "c-psl1", "c-psl1-1x2", "c-psl1-a", decimal_odds=3.50))

    # t2 — tennis 2.10/2.05 but across INCOMPATIBLE retirement rules (A vs C) -> rule-risk flag
    beta.script_update(S(2, "a-wta1", "a-wta1-ml", "a-wta1-p1", decimal_odds=2.10))
    charlie.script_update(S(2, "c-wta1", "c-wta1-ml", "c-wta1-p2", decimal_odds=2.05))

    # t3 — Bravo (same rules group as Alpha) posts P2 @ 2.06 -> clean pure arb replaces it
    bravo.script_update(S(3, "b-wta1", "b-wta1-ml", "b-wta1-p2", decimal_odds=2.06))

    # t4 — bookie-vs-Polymarket (§14.1: PM YES 0.50 fee 0.05 vs bookie 2.10 -> ~1.1%)
    beta.script_update(S(4, "a-nba1", "a-nba1-ml", "a-nba1-a", decimal_odds=2.10, max_stake=15000))
    pm.script_update(S(4, "pm-nba1", "pm-nba1-will-lakers", "tok-lal-yes",
                       pm_buy_price=0.50, pm_fee_rate=0.05, depth_shares=4000))

    # t5 — PM-internal YES+NO: 0.48 + 0.50 with sports fee 0.05 -> cost 1.005 -> NO ARB
    pm.script_update(S(5, "pm-mention", "pm-mention-q", "tok-th-yes",
                       pm_buy_price=0.48, pm_fee_rate=0.05, depth_shares=3000))
    pm.script_update(S(5, "pm-mention", "pm-mention-q", "tok-th-no",
                       pm_buy_price=0.50, pm_fee_rate=0.05, depth_shares=3000))

    # t6 — negRisk full set: 0.30/0.32/0.33 @ fee 0.04 -> cost ~0.976 -> ~2.4% internal arb
    for i, price in enumerate((0.30, 0.32, 0.33)):
        pm.script_update(S(6, "pm-jhb-mayor", f"pm-mayor-{i}", f"tok-mayor-{i}-yes",
                           pm_buy_price=price, pm_fee_rate=0.04, depth_shares=5000))

    # t7 — books move away: everything expires, windows recorded
    beta.script_update(S(7, "a-psl1", "a-psl1-1x2", "a-psl1-h", decimal_odds=2.20))
    beta.script_update(S(7, "a-wta1", "a-wta1-ml", "a-wta1-p1", decimal_odds=1.90))
    beta.script_update(S(7, "a-nba1", "a-nba1-ml", "a-nba1-a", decimal_odds=1.95))
    pm.script_update(S(7, "pm-jhb-mayor", "pm-mayor-0", "tok-mayor-0-yes",
                       pm_buy_price=0.36, pm_fee_rate=0.04, depth_shares=5000))


async def ingest_catalogue(world: SimWorld) -> None:
    """Feed events + markets through the matcher/normalizer (one-off setup)."""
    for venue in world.venues.values():
        for ev in await venue.discover_events("*"):
            await world.normalizer.on_raw_event(ev)
        for ref in venue.fixtures:
            for m in await venue.fetch_markets(ref):
                await world.normalizer.on_raw_market(m)


async def run_tick(world: SimWorld, tick: int) -> list:
    """Advance every mock venue to `tick`, push updates through normalizer + engine."""
    emitted = []
    for venue in world.venues.values():
        venue.tick = tick
        for upd in venue.updates_for_tick(tick):
            quote = await world.normalizer.on_raw_odds(upd)
            if quote is not None:
                emitted.extend(await world.engine.on_quote(quote))
    return emitted
