"""Polymarket 2026 fee model (spec §14.3).

    fee_per_share = feeRate * p * (1 - p)

- Symmetric around 50c, peaks at p = 0.5.
- Rounded to 5 decimal places, minimum 0.00001 USDC when a fee applies.
- Taker pays; makers pay 0 (and earn rebates — irrelevant to Phase-1 read-only flow).
- The live CLOB `/fee-rate` endpoint is the source of truth per market; the category
  table here is a fallback only (docs and endpoint have historically disagreed).

Fee-aware effective acquisition price for a marketable (taker) YES/NO buy:
    p_eff = p + fee_per_share(p)        =>  effective decimal odds = 1 / p_eff
Fee-aware effective sale proceeds when unwinding a share:
    proceeds = p - fee_per_share(p)
"""

from __future__ import annotations

MIN_FEE = 0.00001


def taker_fee_per_share(p: float, fee_rate: float) -> float:
    """Fee (in collateral units) charged per share for a taker fill at price p."""
    if fee_rate <= 0 or p <= 0.0 or p >= 1.0:
        return 0.0
    fee = round(fee_rate * p * (1.0 - p), 5)
    return max(fee, MIN_FEE)


def effective_buy_price(p: float, fee_rate: float) -> float:
    """Cost per share including taker fee."""
    return p + taker_fee_per_share(p, fee_rate)


def effective_sell_proceeds(p: float, fee_rate: float) -> float:
    """Proceeds per share when selling at bid p, net of taker fee."""
    return max(p - taker_fee_per_share(p, fee_rate), 0.0)


def effective_decimal_odds(p: float, fee_rate: float) -> float:
    """Decimal odds equivalent of buying this outcome at ask p (fee-aware).

    A share pays exactly 1 collateral unit on resolution, so odds = 1 / p_eff.
    """
    p_eff = effective_buy_price(p, fee_rate)
    if p_eff <= 0:
        raise ValueError(f"invalid effective price {p_eff} (p={p}, fee_rate={fee_rate})")
    return 1.0 / p_eff


def binary_pair_cost(p_yes: float, p_no: float, fee_rate: float) -> float:
    """Total cost of buying 1 YES + 1 NO at asks (Polymarket-internal arb iff < 1)."""
    return effective_buy_price(p_yes, fee_rate) + effective_buy_price(p_no, fee_rate)


def negrisk_full_set_cost(yes_prices: list[float], fee_rate: float) -> float:
    """Cost of buying 1 YES in every outcome of a complete negRisk set.

    Exactly one outcome resolves YES (the exchange enforces sum-to-1 at resolution),
    so the set pays exactly 1; arb iff cost < 1.
    """
    return sum(effective_buy_price(p, fee_rate) for p in yes_prices)


# Fallback taker fee table (2026). Live /fee-rate wins; see PolymarketConfig.
FEE_FALLBACK_BY_CATEGORY: dict[str, float] = {
    "crypto": 0.07,
    "sports": 0.05,
    "finance": 0.04,
    "politics": 0.04,
    "mentions": 0.04,
    "tech": 0.04,
    "economics": 0.05,
    "culture": 0.05,
    "weather": 0.05,
    "geopolitics": 0.0,
    "other": 0.05,
}

# Maker rebate shares (2026): informational for Phase-3 market-making design.
MAKER_REBATE_SHARE = {"sports": 0.15, "crypto": 0.20, "other": 0.25}


def fee_rate_for_category(category: str | None) -> float:
    if not category:
        return FEE_FALLBACK_BY_CATEGORY["other"]
    return FEE_FALLBACK_BY_CATEGORY.get(category.strip().lower(), FEE_FALLBACK_BY_CATEGORY["other"])
