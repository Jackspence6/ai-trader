"""Polymarket fee model — fixtures straight from spec §14.3 / §14.1."""

import pytest

from oddsengine.fees import (
    binary_pair_cost,
    effective_buy_price,
    effective_decimal_odds,
    fee_rate_for_category,
    negrisk_full_set_cost,
    taker_fee_per_share,
)


def test_fee_peaks_at_half_and_matches_worked_example():
    # sports YES @ p=0.50, feeRate 0.05: fee/share = 0.05*0.5*0.5 = $0.0125
    assert taker_fee_per_share(0.50, 0.05) == pytest.approx(0.0125)
    assert effective_buy_price(0.50, 0.05) == pytest.approx(0.5125)
    assert effective_decimal_odds(0.50, 0.05) == pytest.approx(1.951, abs=1e-3)


def test_fee_symmetry_and_rounding():
    assert taker_fee_per_share(0.3, 0.05) == taker_fee_per_share(0.7, 0.05)
    # rounded to 5 dp
    assert taker_fee_per_share(0.123, 0.04) == round(0.04 * 0.123 * 0.877, 5)
    # min fee when a fee applies
    assert taker_fee_per_share(0.0001, 0.04) == 0.00001
    # geopolitics: feeRate 0 -> no fee
    assert taker_fee_per_share(0.5, 0.0) == 0.0
    assert fee_rate_for_category("geopolitics") == 0.0
    assert fee_rate_for_category("sports") == 0.05
    assert fee_rate_for_category("crypto") == 0.07
    assert fee_rate_for_category(None) == 0.05
    assert fee_rate_for_category("unknown-tag") == 0.05


def test_bookie_vs_polymarket_worked_example():
    # §14.1: PM p_eff=0.5125 -> o_eff=1.951; bookie NO @ 2.10
    s = 1 / effective_decimal_odds(0.50, 0.05) + 1 / 2.10
    assert s == pytest.approx(0.9887, abs=2e-4)
    assert (1 - s) * 100 == pytest.approx(1.13, abs=0.03)  # ~1.1% margin


def test_internal_yes_no_killed_by_fees():
    # §14.1: YES 0.48, NO 0.50, sports fee 0.05 -> cost 1.005 -> NO arb
    cost = binary_pair_cost(0.48, 0.50, 0.05)
    assert cost == pytest.approx(1.005, abs=1e-3)
    assert cost > 1.0


def test_negrisk_full_set():
    cost = negrisk_full_set_cost([0.30, 0.32, 0.33], 0.04)
    assert cost == pytest.approx(0.9759, abs=1e-3)
    assert cost < 1.0  # arb
    # tight set at higher fee flips to no-arb
    assert negrisk_full_set_cost([0.34, 0.33, 0.33], 0.05) > 1.0
