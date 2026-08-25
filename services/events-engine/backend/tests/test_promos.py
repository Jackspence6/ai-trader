"""Promo & rollover hedging math (spec §5 type 5, §14.8, M8).

The researched SA promos are the fixtures: WSB 100% up to R20,000 at 5x rollover
with min odds 1.50, Betway up to R1,000 at 3x, Betfred up to R5,000 at 5x.
"""

from datetime import timedelta

import pytest

from oddsengine.fees import effective_decimal_odds
from oddsengine.models import utcnow
from oddsengine.promos import (
    RESEARCHED_PROMOS,
    BonusKind,
    Promo,
    RolloverProgress,
    evaluate_promo,
    free_bet_value,
    plan_hedge,
    plan_hedge_on_polymarket,
    qualifying_loss_rate,
    rank_promos,
)


def promo(pid: str) -> Promo:
    return next(p for p in RESEARCHED_PROMOS if p.id == pid)


# --------------------------------------------------------------- hedge math

def test_qualifying_loss_rate_is_the_overround_you_pay():
    # A fair pair (no margin) costs nothing to turn over.
    assert qualifying_loss_rate(2.0, 2.0) == pytest.approx(0.0, abs=1e-12)
    # A typical hedged pair burns a couple of percent of each stake.
    assert qualifying_loss_rate(2.0, 1.95) == pytest.approx(0.02564, abs=1e-5)
    # A pair that is itself an arb has a NEGATIVE loss rate — free turnover.
    assert qualifying_loss_rate(2.10, 2.05) < 0


def test_hedge_plan_pays_the_same_either_way():
    p = plan_hedge(back_odds=2.0, hedge_odds=1.95, back_stake_zar=1000)
    assert p.hedge_stake_zar == pytest.approx(1025.64, abs=0.01)
    # Both branches return the same amount — that's the point of the hedge.
    assert p.back_stake_zar * p.back_odds == pytest.approx(p.hedge_stake_zar * p.hedge_odds, abs=1e-6)
    assert p.guaranteed_return_zar == pytest.approx(2000.0)
    assert p.loss_zar == pytest.approx(25.64, abs=0.01)
    assert p.loss_rate == pytest.approx(0.02564, abs=1e-5)
    # Only the bookmaker leg counts toward rollover.
    assert p.turnover_zar == 1000


def test_hedging_on_polymarket_is_fee_aware():
    p = plan_hedge_on_polymarket(back_odds=2.0, pm_price=0.50, pm_fee_rate=0.05,
                                 back_stake_zar=1000)
    assert p.hedge_is_polymarket
    assert p.hedge_odds == pytest.approx(effective_decimal_odds(0.50, 0.05))
    # The 5% sports fee makes the hedge worse than the raw 2.00 the price implies.
    assert p.hedge_odds < 2.0
    assert p.loss_rate > qualifying_loss_rate(2.0, 2.0)


def test_rejects_impossible_odds():
    for bad in (1.0, 0.5, -2):
        with pytest.raises(ValueError):
            qualifying_loss_rate(bad, 2.0)
        with pytest.raises(ValueError):
            qualifying_loss_rate(2.0, bad)
    with pytest.raises(ValueError):
        plan_hedge(2.0, 1.95, 0)


# --------------------------------------------------------------- promo EV

def test_wsb_promo_is_strongly_positive_at_realistic_hedge_quality():
    """WSB: R20,000 bonus, 5x rollover => R100,000 turnover, min odds 1.50."""
    p = promo("wsb_signup_2026")
    assert p.required_turnover_zar == 100_000
    # Backing at 1.55 means hedging the OPPOSITE outcome near 2.75.
    ev = evaluate_promo(p, back_odds=1.55, hedge_odds=2.75)
    # ~1.4% loss rate on R100k of turnover ≈ R1.4k of cost against a R20k bonus
    assert ev.loss_rate == pytest.approx(0.0136, abs=0.002)
    assert ev.total_hedging_cost_zar < 2500
    assert ev.expected_value_zar > 15_000
    assert ev.viable
    assert ev.break_even_loss_rate == pytest.approx(0.20)


def test_min_odds_term_is_enforced_not_assumed():
    p = promo("wsb_signup_2026")   # min odds 1.50
    ev = evaluate_promo(p, back_odds=1.20, hedge_odds=6.0)
    assert not ev.viable
    assert any("minimum" in w for w in ev.warnings)


def test_bad_hedge_quality_kills_a_high_rollover_promo():
    p = promo("wsb_signup_2026")   # 5x => break-even at 20%
    ev = evaluate_promo(p, back_odds=2.0, hedge_odds=1.30)  # dreadful hedge
    assert ev.loss_rate > ev.break_even_loss_rate
    assert ev.expected_value_zar < 0
    assert not ev.viable
    assert any("break-even" in w for w in ev.warnings)


def test_rollover_multiple_sets_the_headroom():
    # 3x tolerates a 33% loss rate; 5x only 20%.
    betway = evaluate_promo(promo("betway_signup_2026"), 2.0, 1.95)
    wsb = evaluate_promo(promo("wsb_signup_2026"), 2.0, 1.95)
    assert betway.break_even_loss_rate == pytest.approx(1 / 3, abs=1e-9)
    assert wsb.break_even_loss_rate == pytest.approx(0.20)
    # Same hedge quality, but WSB's far larger bonus dominates on absolute EV.
    assert wsb.expected_value_zar > betway.expected_value_zar


def test_one_per_household_is_always_surfaced():
    for p in RESEARCHED_PROMOS:
        if p.bonus_zar <= 0:
            continue
        ev = evaluate_promo(p, 1.60, 2.60)
        assert any("one genuine account" in w for w in ev.warnings), (
            "the one-account-per-person constraint must never be silently dropped"
        )


def test_ranking_puts_the_best_promo_first():
    ranked = rank_promos(RESEARCHED_PROMOS, back_odds=1.60, hedge_odds=2.60)
    assert ranked[0].promo_id == "wsb_signup_2026"
    assert [e.expected_value_zar for e in ranked] == sorted(
        (e.expected_value_zar for e in ranked), reverse=True)


def test_deadline_pressure_is_flagged():
    p = Promo(id="tight", venue_id="x", name="tight deadline", bonus_zar=20000,
              rollover_multiple=5, min_odds=1.5, deadline_days=7)
    ev = evaluate_promo(p, 1.60, 2.60)
    assert ev.ev_per_day is not None
    # R100k of turnover in 7 days is >R14k/day — a real account-safety signal.
    assert any("account-safety" in w for w in ev.warnings)


# --------------------------------------------------------------- free bets

def test_implausible_pair_is_flagged_not_silently_priced():
    """Passing two prices for the same side used to produce a plausible-looking
    47% loss rate. It must be called out."""
    ev = evaluate_promo(promo("wsb_signup_2026"), back_odds=1.55, hedge_odds=1.52)
    assert any("overround" in w for w in ev.warnings)


def test_free_bet_retention_rises_with_odds():
    # Stake not returned, so a free bet is worth less than face value.
    low = free_bet_value(100, odds=2.0, hedge_odds=1.95)
    high = free_bet_value(100, odds=6.0, hedge_odds=1.20)
    assert low < high < 100
    assert high == pytest.approx(83.33, abs=0.01)


def test_free_bet_promo_ev_uses_retained_value_not_face_value():
    cash = Promo(id="c", venue_id="v", name="cash", bonus_zar=1000,
                 rollover_multiple=1, kind=BonusKind.CASH)
    free = Promo(id="f", venue_id="v", name="free bet", bonus_zar=1000,
                 rollover_multiple=1, kind=BonusKind.FREE_BET)
    ev_cash = evaluate_promo(cash, 2.0, 1.95)
    ev_free = evaluate_promo(free, 2.0, 1.95)
    assert ev_free.expected_value_zar < ev_cash.expected_value_zar
    assert any("face value" in w for w in ev_free.warnings)


# --------------------------------------------------------- rollover tracking

def test_rollover_progress_tracks_pace_against_the_deadline():
    started = utcnow() - timedelta(days=5)
    deadline = started + timedelta(days=10)
    behind = RolloverProgress("p", required_zar=100_000, completed_zar=10_000,
                              started_at=started, deadline=deadline)
    assert behind.remaining_zar == 90_000
    assert behind.pct_complete == pytest.approx(10.0)
    assert not behind.on_track()
    assert behind.required_daily_zar() == pytest.approx(18_000, rel=0.05)

    ahead = RolloverProgress("p", required_zar=100_000, completed_zar=80_000,
                             started_at=started, deadline=deadline)
    assert ahead.on_track()


def test_rollover_without_deadline_is_never_behind():
    prog = RolloverProgress("p", required_zar=50_000, completed_zar=0,
                            started_at=utcnow(), deadline=None)
    assert prog.on_track()
    assert prog.required_daily_zar() is None


def test_completed_rollover_reports_no_remaining():
    prog = RolloverProgress("p", required_zar=1000, completed_zar=1500,
                            started_at=utcnow(), deadline=None)
    assert prog.remaining_zar == 0
    assert prog.pct_complete == 100.0
