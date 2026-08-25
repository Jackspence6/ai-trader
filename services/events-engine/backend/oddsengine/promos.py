"""Promo & bonus-rollover hedging math (spec §5 type 5, §14.8, milestone M8).

Why this matters more than it looks: the spec's own benchmark says that if manual
capture rate on live arbs comes in under 30%, promo/rollover hedging becomes the
*primary* edge — "its windows are days, not seconds, and its EV is more robust to
execution lag." Live cross-platform arb windows have collapsed to ~2.7s; a rollover
deadline is measured in weeks. This module is the math for that edge.

THE MODEL
---------
A bonus of B carries a rollover multiple R at minimum odds o_min: you must turn over
T = B x R in qualifying bets before the balance is withdrawable. Each qualifying bet
is hedged so the outcome doesn't matter — you deliberately lose a small, known amount
per cycle and keep the bonus.

For one hedged cycle, backing at decimal odds b and hedging the complement at
effective decimal odds h:

    stake S at the book, hedge H = S*b/h  (equalises the two payouts)
    guaranteed return       = S*b
    total outlay            = S + H
    loss per unit of stake  L = 1 + b/h - b          <- the "qualifying loss rate"

Turning over T at that rate costs T*L, so:

    EV = B - T*L = B * (1 - R*L)

which is positive whenever L < 1/R. A 5x rollover survives a 20% qualifying loss
rate; a 3x rollover survives 33%. Real hedged pairs land around 2-6%, which is why
this edge is robust — it has an order of magnitude of headroom that a 1% arb does not.

The hedge venue here is normally Polymarket: South Africa has no deep betting
exchange, but a fee-aware PM leg is exactly an exchange lay. fees.effective_decimal_odds
converts a PM ask into h.

WHAT THIS MODULE DELIBERATELY DOES NOT DO
-----------------------------------------
It never plans more than one genuine account per person per venue. Promo terms are
one-bonus-per-person/household/IP (WSB's terms are explicit); the Phase-2 schema
enforces UNIQUE(person_id, venue_id). Multi-accounting is an explicit non-goal of
this project, and no amount of EV changes that.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .compat import StrEnum
from .fees import effective_decimal_odds
from .models import utcnow


class BonusKind(StrEnum):
    #: Bonus lands as withdrawable-after-rollover cash. Losing the qualifying bet
    #: still costs real money, but the bonus itself is worth face value.
    CASH = "cash"
    #: "Free bet": stake is not returned on a win, so a free bet at odds b is worth
    #: (b - 1) x face value when used, not b. Materially changes EV.
    FREE_BET = "free_bet"


@dataclass
class Promo:
    id: str
    venue_id: str
    name: str
    bonus_zar: float
    rollover_multiple: float
    min_odds: float = 1.0
    kind: BonusKind = BonusKind.CASH
    deposit_required_zar: float = 0.0
    deadline_days: int | None = None
    one_per_household: bool = True
    terms_note: str = ""

    @property
    def required_turnover_zar(self) -> float:
        return self.bonus_zar * self.rollover_multiple


@dataclass
class HedgePlan:
    """One qualifying cycle: back at the book, hedge the complement."""

    back_odds: float
    hedge_odds: float
    back_stake_zar: float
    hedge_stake_zar: float
    total_outlay_zar: float
    guaranteed_return_zar: float
    loss_zar: float
    loss_rate: float            # loss as a fraction of the back stake
    hedge_is_polymarket: bool = False
    hedge_price: float | None = None
    hedge_fee_rate: float | None = None

    @property
    def turnover_zar(self) -> float:
        """Only the bookmaker leg counts toward a rollover requirement."""
        return self.back_stake_zar


#: Overround above which a (back, hedge) pair almost certainly isn't a true
#: complement — e.g. someone passed two prices for the same side. Real two-way
#: markets sit near 1.02-1.08.
IMPLAUSIBLE_OVERROUND = 1.15


def pair_overround(back_odds: float, hedge_odds: float) -> float:
    """1/b + 1/h. Equals 1 for a fair pair; above 1 by the bookmaker's margin."""
    return 1.0 / back_odds + 1.0 / hedge_odds


def qualifying_loss_rate(back_odds: float, hedge_odds: float) -> float:
    """L = 1 + b/h - b — the fraction of each back stake burned to hedge it.

    hedge_odds are the odds of the OPPOSITE outcome, not another price for the same
    one. Backing at 1.55 means hedging near 2.75, not near 1.5 — get that wrong and
    L looks catastrophic (47% instead of 1.4%), which is why evaluate_promo warns on
    an implausible overround.

    Negative means the pair is itself an arbitrage: free turnover, and then some.
    """
    if back_odds <= 1.0 or hedge_odds <= 1.0:
        raise ValueError("decimal odds must be > 1")
    return 1.0 + back_odds / hedge_odds - back_odds


def plan_hedge(back_odds: float, hedge_odds: float, back_stake_zar: float) -> HedgePlan:
    if back_stake_zar <= 0:
        raise ValueError("back stake must be positive")
    hedge_stake = back_stake_zar * back_odds / hedge_odds
    guaranteed = back_stake_zar * back_odds
    outlay = back_stake_zar + hedge_stake
    loss = outlay - guaranteed
    return HedgePlan(
        back_odds=back_odds, hedge_odds=hedge_odds, back_stake_zar=back_stake_zar,
        hedge_stake_zar=hedge_stake, total_outlay_zar=outlay,
        guaranteed_return_zar=guaranteed, loss_zar=loss,
        loss_rate=loss / back_stake_zar,
    )


def plan_hedge_on_polymarket(back_odds: float, pm_price: float, pm_fee_rate: float,
                             back_stake_zar: float) -> HedgePlan:
    """Hedge a bookmaker qualifying bet against a fee-aware Polymarket leg."""
    hedge_odds = effective_decimal_odds(pm_price, pm_fee_rate)
    plan = plan_hedge(back_odds, hedge_odds, back_stake_zar)
    plan.hedge_is_polymarket = True
    plan.hedge_price = pm_price
    plan.hedge_fee_rate = pm_fee_rate
    return plan


def free_bet_value(face_value_zar: float, odds: float, hedge_odds: float) -> float:
    """Extractable value of a free bet (stake not returned) once hedged.

    Back the free bet at odds b: a win pays F*(b-1) because the stake is not
    returned. Hedge H on the complement at h so both branches pay the same:

        F*(b-1) - H  =  H*(h-1)   =>   H = F*(b-1)/h
        retained     =  H*(h-1)   =   F*(b-1)*(h-1)/h

    Retention rises with the back odds, which is why free bets are cleared on
    longshots while cash bonuses are cleared at the minimum qualifying odds.
    A R100 free bet at 6.0 hedged at 1.20 retains R83.
    """
    if odds <= 1.0 or hedge_odds <= 1.0:
        raise ValueError("decimal odds must be > 1")
    hedge_stake = face_value_zar * (odds - 1.0) / hedge_odds
    return hedge_stake * (hedge_odds - 1.0)


@dataclass
class PromoEV:
    promo_id: str
    venue_id: str
    bonus_zar: float
    required_turnover_zar: float
    loss_rate: float
    cycles: int
    cycle_stake_zar: float
    total_hedging_cost_zar: float
    expected_value_zar: float
    ev_per_day: float | None
    break_even_loss_rate: float
    viable: bool
    warnings: list[str] = field(default_factory=list)


def evaluate_promo(
    promo: Promo,
    back_odds: float,
    hedge_odds: float,
    *,
    cycle_stake_zar: float | None = None,
    now: datetime | None = None,
) -> PromoEV:
    """EV of clearing a promo by hedging every qualifying bet.

    back_odds must satisfy the promo's minimum-odds term, or the turnover doesn't
    count and the whole plan is void — that is checked, not assumed.
    """
    warnings: list[str] = []
    if back_odds < promo.min_odds:
        warnings.append(
            f"back odds {back_odds:.2f} are below the promo's minimum {promo.min_odds:.2f} — "
            f"these bets would not count toward rollover",
        )
    loss_rate = qualifying_loss_rate(back_odds, hedge_odds)
    overround = pair_overround(back_odds, hedge_odds)
    if overround > IMPLAUSIBLE_OVERROUND:
        warnings.append(
            f"back {back_odds:.2f} / hedge {hedge_odds:.2f} implies a {overround - 1:.0%} "
            f"overround — check the hedge is the OPPOSITE outcome, not the same side",
        )
    turnover = promo.required_turnover_zar

    stake = cycle_stake_zar or max(turnover / 10.0, 50.0)
    cycles = max(1, int(round(turnover / stake)))
    hedging_cost = turnover * loss_rate

    if promo.kind == BonusKind.FREE_BET:
        realisable_bonus = free_bet_value(promo.bonus_zar, back_odds, hedge_odds)
        warnings.append("free bet: stake is not returned, so face value overstates the edge")
    else:
        realisable_bonus = promo.bonus_zar

    ev = realisable_bonus - hedging_cost
    break_even = 1.0 / promo.rollover_multiple if promo.rollover_multiple else float("inf")

    ev_per_day = None
    if promo.deadline_days:
        ev_per_day = ev / promo.deadline_days
        required_daily = turnover / promo.deadline_days
        if required_daily > 5000:
            warnings.append(
                f"clearing this needs R{required_daily:,.0f}/day of turnover — that pace is "
                f"itself an account-safety signal (§14.8)",
            )

    if promo.one_per_household:
        warnings.append("one bonus per person/household/IP — one genuine account only")
    if loss_rate >= break_even:
        warnings.append(
            f"loss rate {loss_rate:.1%} exceeds the {break_even:.1%} break-even for a "
            f"{promo.rollover_multiple:g}x rollover",
        )
    _ = now or utcnow()

    return PromoEV(
        promo_id=promo.id, venue_id=promo.venue_id, bonus_zar=promo.bonus_zar,
        required_turnover_zar=turnover, loss_rate=loss_rate, cycles=cycles,
        cycle_stake_zar=stake, total_hedging_cost_zar=hedging_cost,
        expected_value_zar=ev, ev_per_day=ev_per_day, break_even_loss_rate=break_even,
        viable=ev > 0 and back_odds >= promo.min_odds, warnings=warnings,
    )


@dataclass
class RolloverProgress:
    promo_id: str
    required_zar: float
    completed_zar: float
    started_at: datetime
    deadline: datetime | None

    @property
    def remaining_zar(self) -> float:
        return max(self.required_zar - self.completed_zar, 0.0)

    @property
    def pct_complete(self) -> float:
        return 0.0 if not self.required_zar else min(self.completed_zar / self.required_zar, 1.0) * 100.0

    def required_daily_zar(self, now: datetime | None = None) -> float | None:
        if self.deadline is None:
            return None
        days = max((self.deadline - (now or utcnow())).total_seconds() / 86400.0, 0.01)
        return self.remaining_zar / days

    def on_track(self, now: datetime | None = None) -> bool:
        if self.deadline is None:
            return True
        now = now or utcnow()
        total = (self.deadline - self.started_at).total_seconds()
        if total <= 0:
            return self.remaining_zar <= 0
        elapsed_frac = max(0.0, min((now - self.started_at).total_seconds() / total, 1.0))
        return (self.completed_zar / self.required_zar if self.required_zar else 1.0) >= elapsed_frac


# Promos researched in the spec (§ Key findings). Terms MUST be re-verified against
# the operator's own account before any of these are relied on — they change often
# and vary by jurisdiction. Deliberately inactive until verified.
RESEARCHED_PROMOS: list[Promo] = [
    # The only one whose deposit term is explicit in the offer name: a 100% match,
    # so the bonus equals the deposit and scales down pro rata below the cap.
    Promo(id="wsb_signup_2026", venue_id="wsb", name="WSB 100% deposit match",
          bonus_zar=20000, rollover_multiple=5, min_odds=1.50,
          deposit_required_zar=20000,
          terms_note="100% up to R20,000, 5x rollover, min odds 1.50, one per person/household/IP"),
    Promo(id="betway_signup_2026", venue_id="betway_sa", name="Betway signup bonus",
          bonus_zar=1000, rollover_multiple=3, min_odds=1.0,
          terms_note="up to R1,000 at 3x rollover"),
    Promo(id="betfred_signup_2026", venue_id="betfred_sa", name="Betfred SA signup bonus",
          bonus_zar=5000, rollover_multiple=5, min_odds=1.0,
          terms_note="up to R5,000 at 5x rollover"),
    Promo(id="hwb_bonus_2026", venue_id="hollywoodbets", name="Hollywoodbets bonus",
          bonus_zar=0, rollover_multiple=1, min_odds=1.50,
          terms_note="bonuses require odds >= 5/10 (1.50); amount varies by offer"),
]


def rank_promos(promos: list[Promo], back_odds: float, hedge_odds: float) -> list[PromoEV]:
    """Rank promos by expected value under one assumed hedge quality."""
    evs = [evaluate_promo(p, back_odds, hedge_odds) for p in promos if p.bonus_zar > 0]
    return sorted(evs, key=lambda e: e.expected_value_zar, reverse=True)


def deadline_for(promo: Promo, started_at: datetime | None = None) -> datetime | None:
    if promo.deadline_days is None:
        return None
    return (started_at or utcnow()) + timedelta(days=promo.deadline_days)
