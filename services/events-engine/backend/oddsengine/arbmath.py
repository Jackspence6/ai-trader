"""Arbitrage math (spec §5, worked ZAR examples §14.1 are the unit-test fixtures).

Core identities:
    implied prob     q_i = 1 / o_i
    inverse sum      S   = sum(q_i)
    arb condition    S < 1
    margin           M   = 1 - S
    stakes           stake_i = T * q_i / S      (equalizes payout across outcomes)
    return           T / S ; profit T * (1/S - 1)

Polymarket legs convert to fee-aware decimal odds via fees.effective_decimal_odds
(o_eff = 1 / (p + f*p*(1-p))) before entering these formulas.
"""

from __future__ import annotations

from dataclasses import dataclass

from .fees import effective_buy_price
from .models import BookLevel


def implied(o: float) -> float:
    if o <= 1.0:
        raise ValueError(f"decimal odds must be > 1, got {o}")
    return 1.0 / o


def inverse_sum(odds: list[float]) -> float:
    return sum(implied(o) for o in odds)


def margin(odds: list[float]) -> float:
    """Arb margin as a fraction; positive iff arbitrage exists."""
    return 1.0 - inverse_sum(odds)


def balanced_stakes(total: float, odds: list[float]) -> list[float]:
    s = inverse_sum(odds)
    return [total * implied(o) / s for o in odds]


def profit_if(stakes: list[float], odds: list[float], winner: int) -> float:
    return stakes[winner] * odds[winner] - sum(stakes)


def worst_case_profit(stakes: list[float], odds: list[float]) -> float:
    return min(profit_if(stakes, odds, i) for i in range(len(odds)))


@dataclass
class StakePlan:
    stakes: list[float]
    total: float
    worst_profit: float
    best_profit: float
    roi_pct: float
    natural: bool          # True when rounded to a natural step and still profitable
    step: float | None


def naturalize_stakes(total: float, odds: list[float], steps: list[float]) -> StakePlan:
    """Round stakes to natural values (nearest R50, else R10) and re-verify the arb
    survives rounding; fall back to exact stakes if no step keeps worst-case > 0.

    Calculator-shaped stakes (odd cents) are a known arber fingerprint (§14.8), so a
    natural plan also feeds the account_safety score.
    """
    exact = balanced_stakes(total, odds)
    for step in steps:
        rounded = [max(step, round(s / step) * step) for s in exact]
        # Greedy repair: bump the worst-return leg by one step (at most twice) if rounding
        # pushed the worst case negative.
        for _ in range(3):
            wp = worst_case_profit(rounded, odds)
            if wp > 0:
                break
            worst_i = min(range(len(odds)), key=lambda i: profit_if(rounded, odds, i))
            rounded[worst_i] += step
        wp = worst_case_profit(rounded, odds)
        if wp > 0:
            tot = sum(rounded)
            bp = max(profit_if(rounded, odds, i) for i in range(len(odds)))
            return StakePlan(rounded, tot, wp, bp, 100.0 * wp / tot, True, step)
    tot = sum(exact)
    wp = worst_case_profit(exact, odds)
    bp = max(profit_if(exact, odds, i) for i in range(len(odds)))
    return StakePlan(exact, tot, wp, bp, 100.0 * wp / tot if tot else 0.0, False, None)


def max_total_for_caps(odds: list[float], caps: list[float | None]) -> float:
    """Largest balanced total T such that every stake_i <= cap_i.

    stake_i = T * q_i / S  =>  T_max = min_i cap_i * S / q_i  over capped legs.
    Uncapped legs (None) don't bind. Returns inf if nothing binds.
    """
    s = inverse_sum(odds)
    t_max = float("inf")
    for o, cap in zip(odds, caps, strict=True):
        if cap is None:
            continue
        t_max = min(t_max, cap * s / implied(o))
    return t_max


def executable_per_leg(odds: list[float], caps: list[float | None]) -> float:
    """Min over legs of the stake each leg carries at the largest balanced total.

    This is the '>= R2,000 executable/leg' quantity in the go/no-go metric.
    """
    t_max = max_total_for_caps(odds, caps)
    if t_max == float("inf"):
        return float("inf")
    stakes = balanced_stakes(t_max, odds)
    return min(stakes)


# ------------------------------------------------------------- order-book depth

@dataclass
class FillResult:
    shares: float
    cost: float                # collateral spent incl. fees
    avg_price_eff: float       # fee-inclusive VWAP per share
    exhausted: bool            # ran out of depth before target


def walk_book(levels: list[BookLevel], target_cost: float, fee_rate: float,
              max_price: float | None = None) -> FillResult:
    """Walk ask levels buying shares until target_cost collateral is spent.

    Fees are price-dependent (f*p*(1-p)) so they are applied per level. max_price
    bounds slippage: levels above it are not consumed.
    """
    shares = 0.0
    cost = 0.0
    for lvl in sorted(levels, key=lambda x: x.price):
        if max_price is not None and lvl.price > max_price:
            break
        unit = effective_buy_price(lvl.price, fee_rate)
        level_cost = unit * lvl.size
        remaining = target_cost - cost
        if remaining <= 0:
            break
        take = min(lvl.size, remaining / unit)
        shares += take
        cost += take * unit
        if take < lvl.size:
            return FillResult(shares, cost, cost / shares if shares else 0.0, False)
        _ = level_cost
    return FillResult(shares, cost, cost / shares if shares else 0.0, cost < target_cost - 1e-9)


def depth_capacity_usd(levels: list[BookLevel], best_ask: float, fee_rate: float,
                       slippage_bps: float) -> float:
    """Collateral that can be deployed within a slippage bound of the best ask.

    Used to cap the PM leg's executable size before FX conversion.
    """
    if not levels or best_ask <= 0:
        return 0.0
    max_price = best_ask * (1.0 + slippage_bps / 10_000.0)
    cap = 0.0
    for lvl in sorted(levels, key=lambda x: x.price):
        if lvl.price > max_price:
            break
        cap += effective_buy_price(lvl.price, fee_rate) * lvl.size
    return cap


def is_middle_candidate(line_a: float | None, line_b: float | None) -> bool:
    """Different lines are never a pure arb; they may form a 'middle' (flagged separately)."""
    if line_a is None or line_b is None:
        return False
    return abs(line_a - line_b) > 1e-9
