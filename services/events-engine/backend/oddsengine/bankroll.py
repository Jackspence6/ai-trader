"""How much money you actually need to start (spec §5 type 5, §14.8).

`promos.py` answers "what is this bonus worth?". This answers the question that
comes immediately after it — "what do I have to put in?" — and they are very
different numbers, for three reasons.

**Turnover is not capital.** A 5x rollover on a R2,000 bonus means R10,000 of
qualifying bets, but not R10,000 of money: each hedged cycle returns ~98.7% of its
outlay when it settles, and that money funds the next cycle. Capital is what you
need *at once*, not what flows through.

**A deposit match scales down, and the deposit comes back.** "100% up to R20,000"
pays R2,000 of bonus on a R2,000 deposit. The deposit is working capital, not a
cost — you withdraw it at the end along with the bonus, minus the hedging cost. So
EV is very close to linear in what you put up, right down to small amounts, which
is what makes starting small sane rather than a compromise.

**Each book's balance swings even though the position is flat.** The hedge makes
the *pair* riskless, but not either leg: back at 2.0 and roughly half those bets
lose, draining the promo book while the hedge book fills up (and vice versa). A
plan that funds only one cycle stalls the first time it hits a losing run. So the
float at each book has to survive a run, and this module sizes that run from the
actual probability rather than a rule of thumb — see `survivable_run`.

What this module will not do: plan more than one genuine account per person per
venue. Promo terms are one-per-person/household/IP and that is not negotiable here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .promos import BonusKind, Promo, free_bet_value, pair_overround, qualifying_loss_rate

#: Smallest bet most SA books will accept. Below this a plan is not executable.
MIN_BET_ZAR = 10.0

#: Chance we accept of a losing run exhausting a book's float mid-clearance.
DEFAULT_RUIN_TOLERANCE = 0.05

#: Every cycle is two bets placed by hand at two books. Past this many the plan is
#: real on paper and a chore in practice, so the planner treats it as a hard ceiling
#: and spends capital on bigger stakes instead of more of them.
DEFAULT_MAX_CYCLES = 60


def run_probability(n_cycles: int, run_length: int, p_loss: float) -> float:
    """P(at least one run of `run_length` consecutive losses in `n_cycles`).

    Exact, by the standard DP over "cycles placed so far, current run length".
    Used instead of a rule of thumb because the answer drives real money: at
    p=0.5 over 40 cycles, a run of 5 is 62% likely and a run of 8 is 12%.
    """
    if run_length <= 0:
        return 1.0
    if n_cycles < run_length:
        return 0.0
    if not 0.0 < p_loss < 1.0:
        raise ValueError("p_loss must be strictly between 0 and 1")

    # state[r] = P(no run yet, current tail of r losses)
    state = [0.0] * run_length
    state[0] = 1.0
    hit = 0.0
    for _ in range(n_cycles):
        nxt = [0.0] * run_length
        for r, prob in enumerate(state):
            if prob == 0.0:
                continue
            if r + 1 >= run_length:
                hit += prob * p_loss
            else:
                nxt[r + 1] += prob * p_loss
            nxt[0] += prob * (1.0 - p_loss)
        state = nxt
    return hit


def survivable_run(n_cycles: int, p_loss: float,
                   tolerance: float = DEFAULT_RUIN_TOLERANCE) -> int:
    """Shortest float, in cycles, that survives the clearance with probability
    >= 1 - tolerance. Always at least 1: you cannot bet money you do not have."""
    for run in range(1, n_cycles + 2):
        if run_probability(n_cycles, run, p_loss) <= tolerance:
            return run
    return n_cycles


@dataclass
class BookFloat:
    venue: str
    stake_per_cycle_zar: float
    buffer_cycles: int
    float_zar: float
    funded_by_bonus_zar: float = 0.0


@dataclass
class CapitalPlan:
    """What clearing one promo actually requires, and what it returns."""

    promo_id: str
    bonus_zar: float
    deposit_zar: float
    turnover_zar: float
    cycle_stake_zar: float
    cycles: int
    loss_rate: float
    hedging_cost_zar: float
    expected_value_zar: float
    promo_book: BookFloat
    hedge_book: BookFloat
    total_capital_zar: float
    capital_at_risk_zar: float
    return_on_capital_pct: float
    buffer_cycles: int
    executable: bool
    warnings: list[str] = field(default_factory=list)

    @property
    def cash_out_zar(self) -> float:
        """What you withdraw at the end: your own money back, plus the bonus,
        minus what the hedging cost."""
        return self.total_capital_zar + self.expected_value_zar


def _win_probability(back_odds: float, hedge_odds: float) -> float:
    """Implied, de-vigged probability that the backed side wins."""
    q_back, q_hedge = 1.0 / back_odds, 1.0 / hedge_odds
    total = q_back + q_hedge
    return q_back / total if total else 0.5


def plan_capital(
    promo: Promo,
    back_odds: float,
    hedge_odds: float,
    *,
    deposit_zar: float,
    cycle_stake_zar: float | None = None,
    tolerance: float = DEFAULT_RUIN_TOLERANCE,
) -> CapitalPlan:
    """Cost this promo out at a chosen deposit size.

    `deposit_zar` is what you put into the promo book. For a deposit-match bonus
    that also sets the bonus, capped at the promo's advertised maximum.
    """
    warnings: list[str] = []
    if deposit_zar <= 0:
        raise ValueError("deposit must be positive")

    # A deposit match pays out pro rata. A fixed bonus does not scale.
    if promo.deposit_required_zar > 0:
        match_ratio = promo.bonus_zar / promo.deposit_required_zar
        bonus = min(deposit_zar * match_ratio, promo.bonus_zar)
    else:
        bonus = promo.bonus_zar
        warnings.append(
            "promo has no recorded deposit requirement — treated as a fixed bonus, so "
            "EV does NOT scale with the deposit. Verify the terms before relying on this.",
        )

    loss_rate = qualifying_loss_rate(back_odds, hedge_odds)
    overround = pair_overround(back_odds, hedge_odds)
    turnover = bonus * promo.rollover_multiple

    if back_odds < promo.min_odds:
        warnings.append(
            f"back odds {back_odds:.2f} are below the promo minimum {promo.min_odds:.2f} — "
            f"this turnover would not count",
        )

    # The promo book's betting balance is the deposit plus the bonus.
    book_balance = deposit_zar + bonus
    stake = cycle_stake_zar or max(book_balance / 8.0, MIN_BET_ZAR)
    stake = max(stake, MIN_BET_ZAR)
    cycles = max(1, math.ceil(turnover / stake))

    p_loss = 1.0 - _win_probability(back_odds, hedge_odds)
    buffer_cycles = survivable_run(cycles, p_loss, tolerance)

    hedge_stake = stake * back_odds / hedge_odds
    promo_float_needed = stake * buffer_cycles
    hedge_float_needed = hedge_stake * buffer_cycles

    promo_book = BookFloat(
        venue=promo.venue_id, stake_per_cycle_zar=stake, buffer_cycles=buffer_cycles,
        float_zar=promo_float_needed, funded_by_bonus_zar=min(bonus, promo_float_needed),
    )
    hedge_book = BookFloat(
        venue="hedge", stake_per_cycle_zar=hedge_stake, buffer_cycles=buffer_cycles,
        float_zar=hedge_float_needed,
    )

    if promo_float_needed > book_balance:
        warnings.append(
            f"a run of {buffer_cycles} losses would need R{promo_float_needed:,.0f} at "
            f"{promo.venue_id} but the balance is only R{book_balance:,.0f} — lower the "
            f"cycle stake or raise the deposit",
        )

    hedging_cost = turnover * loss_rate
    realisable = (free_bet_value(bonus, back_odds, hedge_odds)
                  if promo.kind == BonusKind.FREE_BET else bonus)
    ev = realisable - hedging_cost

    total_capital = deposit_zar + hedge_float_needed
    roc = (ev / total_capital * 100.0) if total_capital else 0.0

    if overround > 1.15:
        warnings.append(
            f"back {back_odds:.2f} / hedge {hedge_odds:.2f} implies a {overround - 1:.0%} "
            f"overround — check the hedge is the OPPOSITE outcome",
        )
    if stake < MIN_BET_ZAR:
        warnings.append(f"cycle stake below the R{MIN_BET_ZAR:.0f} minimum bet")
    if loss_rate >= 1.0 / promo.rollover_multiple:
        warnings.append(
            f"loss rate {loss_rate:.1%} exceeds the {1 / promo.rollover_multiple:.1%} "
            f"break-even for a {promo.rollover_multiple:g}x rollover",
        )
    if cycles > 200:
        warnings.append(
            f"{cycles} cycles at R{stake:,.0f} is a lot of manual placements — raise the "
            f"cycle stake if the float allows",
        )

    return CapitalPlan(
        promo_id=promo.id, bonus_zar=bonus, deposit_zar=deposit_zar, turnover_zar=turnover,
        cycle_stake_zar=stake, cycles=cycles, loss_rate=loss_rate,
        hedging_cost_zar=hedging_cost, expected_value_zar=ev,
        promo_book=promo_book, hedge_book=hedge_book,
        total_capital_zar=total_capital,
        capital_at_risk_zar=hedging_cost,
        return_on_capital_pct=roc, buffer_cycles=buffer_cycles,
        executable=ev > 0 and back_odds >= promo.min_odds and stake >= MIN_BET_ZAR,
        warnings=warnings,
    )


def plan_from_capital(
    promo: Promo,
    back_odds: float,
    hedge_odds: float,
    *,
    capital_zar: float,
    tolerance: float = DEFAULT_RUIN_TOLERANCE,
    max_cycles: int = DEFAULT_MAX_CYCLES,
) -> CapitalPlan:
    """The question people actually ask: I have R`capital_zar` — what happens?

    For a deposit-match promo EV is linear in the deposit and the hedge float only
    changes how fast it clears, so the split is a search for the largest deposit
    that still leaves a workable float. That is what this does, on a coarse grid,
    keeping the best executable plan by EV.

    `max_cycles` is what stops the search running away. Without it the optimiser
    happily proposes putting 95% of the money on deposit and clearing R14,000 of
    turnover in 1,266 hand-placed bets of R11 — arithmetically optimal, and not a
    thing a person will do.
    """
    if capital_zar <= 0:
        raise ValueError("capital must be positive")

    best: CapitalPlan | None = None
    fallback: CapitalPlan | None = None
    for frac in [i / 100.0 for i in range(50, 96, 5)]:
        deposit = capital_zar * frac
        if deposit < MIN_BET_ZAR:
            continue
        hedge_budget = capital_zar - deposit
        # Size the cycle so the hedge float covers a losing run; solved by
        # iterating, since the run length depends on the cycle count.
        stake = max(hedge_budget / 8.0, MIN_BET_ZAR)
        for _ in range(8):
            plan = plan_capital(promo, back_odds, hedge_odds, deposit_zar=deposit,
                                cycle_stake_zar=stake, tolerance=tolerance)
            need = plan.hedge_book.float_zar
            if need <= hedge_budget * 1.001:
                break
            stake *= hedge_budget / need
            stake = max(stake, MIN_BET_ZAR)
        else:
            plan = plan_capital(promo, back_odds, hedge_odds, deposit_zar=deposit,
                                cycle_stake_zar=stake, tolerance=tolerance)
        fallback = fallback or plan
        if plan.cycles > max_cycles:
            continue
        if plan.executable and plan.hedge_book.float_zar <= hedge_budget * 1.001:
            if best is None or plan.expected_value_zar > best.expected_value_zar:
                best = plan
    chosen = best or fallback
    assert chosen is not None
    if best is None:
        chosen.warnings.append(
            f"R{capital_zar:,.0f} cannot clear this promo within {max_cycles} cycles while "
            f"keeping a float that survives a losing run — the plan below is the closest "
            f"fit, not a safe one",
        )
    return chosen


def days_to_clear(plan: CapitalPlan, cycles_per_day: float) -> float:
    """Calendar time, given how many hedged pairs a day you can actually place.

    Settlement matters as much as opportunity: money is locked until the match
    finishes, so same-day soccer is the constraint, not the number of fixtures.
    """
    if cycles_per_day <= 0:
        raise ValueError("cycles_per_day must be positive")
    return plan.cycles / cycles_per_day
