"""Arb math — worked ZAR examples from spec §14.1 are the fixtures."""

import pytest

from oddsengine.arbmath import (
    balanced_stakes,
    depth_capacity_usd,
    executable_per_leg,
    inverse_sum,
    margin,
    max_total_for_caps,
    naturalize_stakes,
    walk_book,
    worst_case_profit,
)
from oddsengine.models import BookLevel


def test_two_way_tennis_example():
    odds = [2.10, 2.05]
    s = inverse_sum(odds)
    assert s == pytest.approx(0.9640, abs=1e-4)
    assert margin(odds) * 100 == pytest.approx(3.60, abs=0.01)
    stakes = balanced_stakes(10_000, odds)
    assert stakes[0] == pytest.approx(4939.7, abs=1.0)   # spec: R4,939
    assert stakes[1] == pytest.approx(5060.3, abs=1.0)   # spec: R5,061
    ret = stakes[0] * odds[0]
    assert ret == pytest.approx(10_373, abs=2)           # spec: ≈R10,373
    assert worst_case_profit(stakes, odds) == pytest.approx(373, abs=3)


def test_three_way_1x2_example():
    odds = [2.40, 3.80, 3.50]
    assert inverse_sum(odds) == pytest.approx(0.9656, abs=1e-4)
    assert margin(odds) * 100 == pytest.approx(3.44, abs=0.01)
    stakes = balanced_stakes(10_000, odds)
    assert stakes[0] == pytest.approx(4315, abs=2)
    assert stakes[1] == pytest.approx(2726, abs=2)
    assert stakes[2] == pytest.approx(2959, abs=3)       # spec prints 2,961 via rounding path
    # Exact profit is T*(1/S - 1) = R356.9; the spec's "≈R344" is the T*M approximation
    # (margin x total). Both formulas appear in spec §5 — the engine uses the exact one.
    assert worst_case_profit(stakes, odds) == pytest.approx(356.9, abs=1.0)
    assert 10_000 * margin(odds) == pytest.approx(344.6, abs=1.0)


def test_naturalization_survives_rounding():
    plan = naturalize_stakes(10_000, [2.40, 3.80, 3.50], [50, 10])
    assert plan.natural and plan.step in (50, 10)
    assert all(s % plan.step == 0 for s in plan.stakes)
    assert plan.worst_profit > 0                          # re-verified after rounding
    # calculator-shaped stakes avoided (§14.8)
    assert plan.worst_profit == pytest.approx(344, abs=40)


def test_naturalization_falls_back_when_rounding_kills_thin_arb():
    # margin ~0.1% on tiny total: R50 rounding cannot survive; must fall back
    odds = [2.001, 2.001]
    plan = naturalize_stakes(200, odds, [50])
    assert plan.worst_profit > 0 or plan.natural is False


def test_caps_and_executable_per_leg():
    odds = [2.10, 2.05]
    caps = [15_000.0, None]
    t_max = max_total_for_caps(odds, caps)
    stakes = balanced_stakes(t_max, odds)
    assert stakes[0] == pytest.approx(15_000, abs=1)      # binding leg hits its cap
    assert executable_per_leg(odds, caps) == pytest.approx(min(stakes), abs=1)
    assert executable_per_leg(odds, [None, None]) == float("inf")


def test_walk_book_fee_aware_and_slippage_bounded():
    levels = [BookLevel(price=0.52, size=1000), BookLevel(price=0.50, size=1000),
              BookLevel(price=0.55, size=5000)]
    fill = walk_book(levels, target_cost=600, fee_rate=0.05)
    assert fill.shares > 0 and fill.cost == pytest.approx(600, abs=1e-6)
    assert fill.avg_price_eff >= 0.50                     # fees + level walking
    # capacity within 50 bps of best ask 0.50 excludes 0.52 and 0.55 levels
    cap = depth_capacity_usd(levels, best_ask=0.50, fee_rate=0.05, slippage_bps=50)
    assert cap == pytest.approx((0.50 + 0.0125) * 1000, abs=1e-6)
    # exhaustion flagged when the target exceeds all depth
    fill2 = walk_book(levels[:1], target_cost=10_000, fee_rate=0.05)
    assert fill2.exhausted
