"""Capital planning: what you must put up, as distinct from what flows through."""

from __future__ import annotations

import pytest

from oddsengine.bankroll import (
    DEFAULT_MAX_CYCLES,
    MIN_BET_ZAR,
    days_to_clear,
    plan_capital,
    plan_from_capital,
    run_probability,
    survivable_run,
)
from oddsengine.promos import BonusKind, Promo, qualifying_loss_rate

# A 100% deposit match: bonus equals deposit, capped at R20,000.
MATCH = Promo(id="match", venue_id="wsb", name="100% match", bonus_zar=20000,
              rollover_multiple=5, min_odds=1.50, deposit_required_zar=20000)
# A fixed bonus that does not scale with what you put in.
FIXED = Promo(id="fixed", venue_id="betfred_sa", name="fixed", bonus_zar=5000,
              rollover_multiple=5, min_odds=1.0)

BACK, HEDGE = 1.96, 1.99        # a real complement pair, ~1.3% overround


# ------------------------------------------------------- losing-run maths

def test_run_probability_matches_the_obvious_cases():
    assert run_probability(1, 2, 0.5) == 0.0            # cannot run 2 in 1 trial
    assert run_probability(2, 2, 0.5) == pytest.approx(0.25)
    assert run_probability(3, 2, 0.5) == pytest.approx(0.375)   # LL_, _LL minus overlap


def test_long_runs_are_likelier_than_people_expect():
    """This is the number that decides how much float each book needs. Over 40
    coin-flip cycles a run of five losses is close to even money, and a run of
    eight still shows up about one time in fourteen."""
    assert run_probability(40, 5, 0.5) == pytest.approx(0.468, abs=0.01)
    assert run_probability(40, 8, 0.5) == pytest.approx(0.072, abs=0.01)


def test_survivable_run_grows_with_the_number_of_cycles():
    short = survivable_run(10, 0.5)
    long = survivable_run(200, 0.5)
    assert 1 <= short < long
    assert run_probability(200, long, 0.5) <= 0.05


def test_survivable_run_is_never_zero():
    assert survivable_run(1, 0.5) >= 1


# ------------------------------------------------- capital is not turnover

def test_capital_is_far_smaller_than_turnover():
    plan = plan_capital(MATCH, BACK, HEDGE, deposit_zar=2000, cycle_stake_zar=200)
    assert plan.turnover_zar == pytest.approx(10000)     # 2000 bonus x 5
    assert plan.total_capital_zar < plan.turnover_zar / 2


def test_the_deposit_comes_back():
    """Cash-out is your own money plus the bonus, less the hedging cost — the
    deposit is working capital, not a fee."""
    plan = plan_capital(MATCH, BACK, HEDGE, deposit_zar=2000, cycle_stake_zar=200)
    assert plan.cash_out_zar == pytest.approx(
        plan.total_capital_zar + plan.bonus_zar - plan.hedging_cost_zar)
    assert plan.cash_out_zar > plan.total_capital_zar


def test_only_the_hedging_cost_is_actually_at_risk():
    plan = plan_capital(MATCH, BACK, HEDGE, deposit_zar=2000, cycle_stake_zar=200)
    assert plan.capital_at_risk_zar == pytest.approx(plan.hedging_cost_zar)
    assert plan.capital_at_risk_zar < plan.total_capital_zar * 0.1


# ------------------------------------------------------- scaling behaviour

def test_a_deposit_match_scales_down_linearly():
    """The reason starting small is sane rather than a compromise."""
    small = plan_capital(MATCH, BACK, HEDGE, deposit_zar=1000, cycle_stake_zar=100)
    big = plan_capital(MATCH, BACK, HEDGE, deposit_zar=10000, cycle_stake_zar=1000)
    assert big.bonus_zar == pytest.approx(small.bonus_zar * 10)
    assert big.expected_value_zar == pytest.approx(small.expected_value_zar * 10, rel=1e-6)


def test_the_match_is_capped():
    plan = plan_capital(MATCH, BACK, HEDGE, deposit_zar=50000, cycle_stake_zar=5000)
    assert plan.bonus_zar == pytest.approx(20000)


def test_a_fixed_bonus_does_not_scale_and_says_so():
    small = plan_capital(FIXED, BACK, HEDGE, deposit_zar=1000, cycle_stake_zar=500)
    big = plan_capital(FIXED, BACK, HEDGE, deposit_zar=9000, cycle_stake_zar=500)
    assert small.bonus_zar == big.bonus_zar == pytest.approx(5000)
    assert any("does NOT scale" in w for w in small.warnings)


# ------------------------------------------------------------- from capital

def test_a_few_thousand_rand_produces_a_real_plan():
    plan = plan_from_capital(MATCH, BACK, HEDGE, capital_zar=2000)
    assert plan.executable
    assert plan.expected_value_zar > 500
    assert plan.cycle_stake_zar >= MIN_BET_ZAR
    assert plan.cycles <= DEFAULT_MAX_CYCLES
    assert plan.deposit_zar + plan.hedge_book.float_zar <= 2000 * 1.01


def test_the_plan_stays_placeable_by_hand():
    """Left unconstrained the optimiser proposes 1,266 bets of R11. It must not."""
    for capital in (1000, 2000, 5000, 20000):
        plan = plan_from_capital(MATCH, BACK, HEDGE, capital_zar=capital)
        assert plan.cycles <= DEFAULT_MAX_CYCLES, capital


def test_more_capital_never_earns_less():
    evs = [plan_from_capital(MATCH, BACK, HEDGE, capital_zar=c).expected_value_zar
           for c in (1000, 2000, 5000, 10000, 20000)]
    assert evs == sorted(evs)


def test_return_on_capital_is_reported_against_money_actually_committed():
    plan = plan_from_capital(MATCH, BACK, HEDGE, capital_zar=5000)
    expected = plan.expected_value_zar / plan.total_capital_zar * 100
    assert plan.return_on_capital_pct == pytest.approx(expected)


# ------------------------------------------------------------- the guards

def test_below_minimum_odds_is_flagged_not_silently_priced():
    plan = plan_capital(MATCH, 1.30, 4.40, deposit_zar=2000, cycle_stake_zar=200)
    assert not plan.executable
    assert any("below the promo minimum" in w for w in plan.warnings)


def test_a_hedge_on_the_same_side_is_caught():
    """1.55 backed and 1.52 'hedged' is two prices for one outcome, not a pair."""
    plan = plan_capital(MATCH, 1.55, 1.52, deposit_zar=2000, cycle_stake_zar=200)
    assert any("overround" in w for w in plan.warnings)


def test_a_rollover_that_cannot_pay_is_flagged():
    """L must stay under 1/R. At 5x that is 20%; this pair burns more."""
    bad_back, bad_hedge = 3.00, 1.20
    assert qualifying_loss_rate(bad_back, bad_hedge) > 0.20
    plan = plan_capital(MATCH, bad_back, bad_hedge, deposit_zar=2000, cycle_stake_zar=200)
    assert any("break-even" in w for w in plan.warnings)
    assert plan.expected_value_zar < 0


def test_one_account_per_person_is_not_negotiable():
    plan = plan_capital(MATCH, BACK, HEDGE, deposit_zar=2000, cycle_stake_zar=200)
    assert MATCH.one_per_household


def test_a_free_bet_is_worth_less_than_its_face_value():
    free = Promo(id="fb", venue_id="x", name="free bet", bonus_zar=1000,
                 rollover_multiple=1, kind=BonusKind.FREE_BET)
    plan = plan_capital(free, 6.0, 1.20, deposit_zar=1000, cycle_stake_zar=200)
    assert plan.expected_value_zar < 1000


def test_float_shortfall_at_the_promo_book_is_reported():
    plan = plan_capital(MATCH, BACK, HEDGE, deposit_zar=200, cycle_stake_zar=190)
    assert any("would need" in w for w in plan.warnings)


# -------------------------------------------------------------- timing

def test_days_to_clear_follows_the_placement_rate():
    plan = plan_from_capital(MATCH, BACK, HEDGE, capital_zar=5000)
    assert days_to_clear(plan, 4) == pytest.approx(plan.cycles / 4)
    assert days_to_clear(plan, 8) < days_to_clear(plan, 2)


def test_placement_rate_must_be_positive():
    plan = plan_from_capital(MATCH, BACK, HEDGE, capital_zar=5000)
    with pytest.raises(ValueError):
        days_to_clear(plan, 0)
