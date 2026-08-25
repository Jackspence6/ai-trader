"""The arbitrage engine — detection, scoring, ranking, lifecycles (spec §5).

Detects, on every quote update for an (event, market) cell:
1. bookie-vs-bookie N-way arbs (1X2, 2-way, totals, handicaps on identical lines)
2. bookie-vs-Polymarket arbs (PM legs enter as fee-adjusted odds)
3. Polymarket-internal arbs (YES+NO < $1 after fees; negRisk full-set < $1)

Every opportunity is measured (dry-run first), scored 0-100 with a persisted
breakdown, and tracked through its lifecycle so window durations feed the go/no-go
report and later survival models.
"""

from __future__ import annotations

from datetime import datetime

from ..arbmath import executable_per_leg, margin, max_total_for_caps, naturalize_stakes
from ..config import AppConfig
from ..fx import FxService
from ..matching import CanonicalRegistry
from ..models import (
    OUTCOME_SETS,
    Leg,
    MarketType,
    Opportunity,
    OpportunityType,
    OppState,
    Quote,
    Sport,
    Urgency,
    utcnow,
)
from ..observability import METRICS, get_logger
from ..rules import legs_clean
from ..scoring import classify_timing, classify_urgency, score_opportunity, staleness_factor
from ..venues.base import VenueAdapter

log = get_logger("engine")

MATERIAL_MARGIN_CHANGE_PP = 0.05


class ArbEngine:
    def __init__(self, cfg: AppConfig, state, bus, fx: FxService,
                 adapters: dict[str, VenueAdapter], registry: CanonicalRegistry, db=None) -> None:
        self.cfg = cfg
        self.state = state
        self.bus = bus
        self.fx = fx
        self.adapters = adapters
        self.registry = registry
        self.db = db
        self._stream_venues = {vid for vid, a in adapters.items() if getattr(a, "is_streaming", False)}

    # ------------------------------------------------------------ helpers
    def _venue_interval(self, venue_id: str) -> float:
        a = self.adapters.get(venue_id)
        iv = a.meta.min_interval_s if a else 0.0
        return iv if iv and iv > 0 else self.cfg.polling.default_interval_s

    def _venue_name(self, venue_id: str) -> str:
        a = self.adapters.get(venue_id)
        return a.meta.name if a else venue_id

    def _venue_softness(self, venue_id: str) -> float:
        a = self.adapters.get(venue_id)
        return a.meta.softness if a else 0.5

    async def _fresh(self, quotes: list[Quote], now: datetime) -> list[Quote]:
        health = await self.state.get_health()
        out = []
        for q in quotes:
            h = health.get(q.venue_id)
            if h is not None and h.state.value in ("quarantined", "stale", "unconfigured"):
                continue
            if q.status.value != "active":
                continue
            if q.venue_id not in self._stream_venues:
                max_age = self._venue_interval(q.venue_id) * self.cfg.staleness.max_age_factor
                if q.age_s(now) > max_age:
                    METRICS.inc("engine.quote_stale_excluded")
                    continue
            out.append(q)
        return out

    @staticmethod
    def _dedupe_mirrors(candidates: list[Quote]) -> tuple[list[Quote], bool]:
        """Mirrored PM liquidity for the SAME outcome (complement-token routes) is one
        book, not two: keep the deepest route, flag the dedupe (spec §5)."""
        seen_pairs: dict[frozenset, Quote] = {}
        out: list[Quote] = []
        mirrored = False
        for q in candidates:
            if not q.is_pm or not q.mirror_of:
                out.append(q)
                continue
            pair = frozenset({q.token_id or "", q.mirror_of})
            prev = seen_pairs.get(pair)
            if prev is None:
                seen_pairs[pair] = q
                out.append(q)
            else:
                mirrored = True
                if (q.max_stake_zar or 0) > (prev.max_stake_zar or 0):
                    out[out.index(prev)] = q
                    seen_pairs[pair] = q
        return out, mirrored

    # -------------------------------------------------------------- main
    async def on_quote(self, quote: Quote) -> list[Opportunity]:
        return await self.recompute(quote.event_id, quote.market_key)

    async def recompute(self, event_id: str, mkey: str) -> list[Opportunity]:
        now = utcnow()
        quotes = await self._fresh(await self.state.get_quotes(event_id, mkey), now)
        mtype_str = mkey.split("|", 1)[0]
        found: list[Opportunity] = []

        if mtype_str == MarketType.NEGRISK_MULTI.value:
            opp = self._detect_negrisk(event_id, mkey, quotes, now)
            if opp:
                found.append(opp)
        else:
            try:
                mtype = MarketType(mtype_str)
            except ValueError:
                return []
            outcomes = OUTCOME_SETS.get(mtype)
            if outcomes:
                opp = self._detect_nway(event_id, mkey, [str(o) for o in outcomes], quotes, now)
                if opp:
                    found.append(opp)

        emitted = []
        for opp in found:
            emitted.append(await self._emit(opp, now))
        await self._expire_stale_opps(event_id, mkey, {o.id for o in found}, now)
        return emitted

    # --------------------------------------------------------- detection
    def _best_per_outcome(self, quotes: list[Quote], outcomes: list[str]) -> tuple[dict[str, Quote] | None, bool]:
        mirrored_any = False
        best: dict[str, Quote] = {}
        for oc in outcomes:
            cands = [q for q in quotes if q.outcome == oc]
            cands, mirrored = self._dedupe_mirrors(cands)
            mirrored_any = mirrored_any or mirrored
            if not cands:
                return None, mirrored_any
            best[oc] = max(cands, key=lambda q: (q.odds_eff, q.max_stake_zar or 0))
        return best, mirrored_any

    def _detect_nway(self, event_id: str, mkey: str, outcomes: list[str],
                     quotes: list[Quote], now: datetime) -> Opportunity | None:
        best, mirrored = self._best_per_outcome(quotes, outcomes)
        if not best:
            return None
        legs_quotes = [best[oc] for oc in outcomes]
        venues = {q.venue_id for q in legs_quotes}
        if len(venues) == 1 and not self.cfg.engine.same_venue_arbs and not legs_quotes[0].is_pm:
            return None
        odds = [q.odds_eff for q in legs_quotes]
        m = margin(odds) * 100.0
        if m < self.cfg.engine.min_margin_pct:
            return None
        return self._build_opportunity(event_id, mkey, legs_quotes, m, mirrored, now)

    def _detect_negrisk(self, event_id: str, mkey: str, quotes: list[Quote],
                        now: datetime) -> Opportunity | None:
        members = [q for q in quotes if q.outcome.startswith("OUT:")]
        if len(members) < 2 or not all(q.neg_risk_complete for q in members):
            return None  # never run full-set math on an incomplete outcome set
        by_out: dict[str, Quote] = {}
        for q in members:
            cur = by_out.get(q.outcome)
            if cur is None or q.odds_eff > cur.odds_eff:
                by_out[q.outcome] = q
        expected = max((q.neg_risk_size or 0) for q in members)
        if expected and len(by_out) < expected:
            METRICS.inc("engine.negrisk_incomplete_quotes")
            return None  # quotes for some outcomes haven't arrived yet — a fake 'arb' otherwise
        legs_quotes = list(by_out.values())
        odds = [q.odds_eff for q in legs_quotes]     # odds_eff = 1 / p_eff
        m = margin(odds) * 100.0                     # 1 - sum(p_eff)
        if m < self.cfg.engine.min_margin_pct:
            return None
        return self._build_opportunity(event_id, mkey, legs_quotes, m, False, now)

    # -------------------------------------------------------- construction
    def _build_opportunity(self, event_id: str, mkey: str, legs_quotes: list[Quote],
                           margin_pct: float, mirrored: bool, now: datetime) -> Opportunity:
        event = self.registry.events.get(event_id)
        sport = event.sport if event else Sport.OTHER
        start = event.start_time if event else None
        minutes_to_start = ((start - now).total_seconds() / 60.0) if start else None
        timing = classify_timing(minutes_to_start, self.cfg.polling.near_kickoff_window_min)
        urgency = Urgency(classify_urgency(timing, minutes_to_start))

        groups = [q.rules_group for q in legs_quotes]
        clean, note = legs_clean(groups)
        rule_risk = not clean

        pm_legs = [q for q in legs_quotes if q.is_pm]
        if pm_legs and len(pm_legs) == len(legs_quotes):
            opp_type = OpportunityType.POLYMARKET_INTERNAL
        elif pm_legs:
            opp_type = OpportunityType.BOOKIE_POLYMARKET
        else:
            opp_type = OpportunityType.BOOKIE_BOOKIE

        odds = [q.odds_eff for q in legs_quotes]
        caps = [q.max_stake_zar for q in legs_quotes]
        t_cap = min(
            self.cfg.engine.total_stake_default_zar,
            self.cfg.engine.max_exposure_zar_per_event,
            max_total_for_caps(odds, caps),
        )
        if rule_risk:
            # Residual risk -> fractional-Kelly style haircut on sizing (spec §5)
            t_cap *= self.cfg.engine.kelly_fraction
        plan = naturalize_stakes(t_cap, odds, self.cfg.engine.stake_rounding_zar)
        exec_per_leg = executable_per_leg(odds, caps)
        if exec_per_leg == float("inf"):
            exec_per_leg = self.cfg.engine.max_exposure_zar_per_event / max(len(odds), 1)

        # Leg ordering: soft/slow book first, sharp/deep venue (PM or sharp book) last.
        order = sorted(
            range(len(legs_quotes)),
            key=lambda i: (legs_quotes[i].is_pm, -self._venue_softness(legs_quotes[i].venue_id)),
        )
        order_index = {i: rank + 1 for rank, i in enumerate(order)}

        legs = [
            Leg(
                venue_id=q.venue_id, venue_name=self._venue_name(q.venue_id), outcome=q.outcome,
                selection_label=q.selection_label, odds=round(q.odds_eff, 4), raw_price=q.raw_price,
                fee_rate=q.fee_rate, stake_zar=round(plan.stakes[i], 2), deep_link=q.deep_link,
                rules_group=q.rules_group, is_pm=q.is_pm, token_id=q.token_id,
                max_stake_zar=q.max_stake_zar, order_index=order_index[i],
            )
            for i, q in enumerate(legs_quotes)
        ]

        opp_id = Opportunity.make_id(event_id, mkey, [(leg.venue_id, leg.outcome) for leg in legs])
        notes = []
        if note:
            notes.append(f"RULE RISK: {note}")
        if any(q.is_pm for q in legs_quotes):
            notes.append("If the PM leg fills late: sell the acquired side to unwind; "
                         "bookie-first ordering already applied.")
            notes.append(f"FX buffered @ {self.fx.buffered_rate:.2f} USDZAR "
                         f"(mid {self.fx.rate:.2f}, buffer {self.cfg.fx.buffer_pct}%).")
        if len({leg.venue_id for leg in legs}) == 1 and not legs[0].is_pm:
            notes.append("SAME-VENUE underround — likely palpable error; expect void. Do not chase.")
        if plan.worst_profit <= 0 and not plan.natural:
            notes.append("Arb does not survive stake rounding at configured steps; exact stakes shown.")

        opp = Opportunity(
            id=opp_id, opp_type=opp_type, event_id=event_id,
            event_label=event.label if event else event_id,
            sport=sport, league=event.league if event else None, start_time=start,
            market_key=mkey, legs=legs, margin_pct=round(margin_pct, 3),
            total_stake_zar=round(plan.total, 2),
            guaranteed_profit_zar=round(plan.worst_profit, 2),
            roi_pct=round(plan.roi_pct, 3),
            executable_zar_per_leg=round(exec_per_leg, 2),
            stakes_natural=plan.natural,
            urgency=urgency, timing=timing, rule_risk=rule_risk, rule_risk_note=note,
            mirrored=mirrored, fx_rate=self.fx.buffered_rate if pm_legs else None,
            first_seen=now, last_seen=now, peak_margin_pct=round(margin_pct, 3),
            notes=notes,
        )

        max_age = max((q.age_s(now) for q in legs_quotes), default=0.0)
        max_interval = max((self._venue_interval(q.venue_id) for q in legs_quotes), default=20.0)
        stale_f = staleness_factor(max_age, max_interval, self.cfg.staleness.max_age_factor)
        windows = getattr(self.state, "window_samples", {})
        samples = windows.get(timing.value) if isinstance(windows, dict) else None
        predicted = (sum(samples) / len(samples)) if samples else None
        score, breakdown = score_opportunity(
            opp, self.cfg.scoring_weights, self.cfg.window_priors,
            min_executable_zar=self.cfg.engine.min_executable_zar,
            leg_softness=[self._venue_softness(q.venue_id) for q in legs_quotes],
            stakes_natural=plan.natural,
            predicted_window_s=predicted,
            staleness=stale_f,
        )
        opp.score, opp.score_breakdown = score, breakdown
        return opp

    # ----------------------------------------------------------- lifecycle
    async def _emit(self, opp: Opportunity, now: datetime) -> Opportunity:
        existing = await self.state.get_opportunity(opp.id)
        is_new = existing is None or existing.state == OppState.EXPIRED
        if existing is not None and existing.state == OppState.ACTIVE:
            opp.first_seen = existing.first_seen
            opp.peak_margin_pct = max(existing.peak_margin_pct, opp.margin_pct)
            opp.last_seen = now
        await self.state.upsert_opportunity(opp)
        if self.db is not None:
            await self.db.record_opportunity(opp)

        if is_new:
            METRICS.inc("engine.opportunities_new")
            await self.state.log_lifecycle(opp.id, opp.margin_pct, "detected", ts=now)
            log.info("opportunity_detected", opportunity_id=opp.id, opp_type=opp.opp_type.value,
                     event_label=opp.event_label, market=opp.market_key, margin_pct=opp.margin_pct,
                     score=opp.score, executable=opp.executable_zar_per_leg)
            await self._publish(opp, kind="new")
        else:
            if abs(opp.margin_pct - existing.margin_pct) >= MATERIAL_MARGIN_CHANGE_PP:
                await self.state.log_lifecycle(opp.id, opp.margin_pct, "update", ts=now)
            if opp.margin_pct >= existing.peak_margin_pct + self.cfg.alerts.resend_margin_improvement_pp:
                await self._publish(opp, kind="improved")
            else:
                await self.bus.publish("opportunities", opp.model_dump(mode="json"))
        return opp

    async def _publish(self, opp: Opportunity, kind: str) -> None:
        await self.bus.publish("opportunities", opp.model_dump(mode="json"))
        alertable = (
            opp.margin_pct >= self.cfg.engine.min_margin_pct
            and opp.executable_zar_per_leg >= self.cfg.engine.min_executable_zar
            and opp.score >= self.cfg.alerts.min_score
        )
        if not alertable:
            METRICS.inc("engine.opportunities_below_alert_threshold")
            return
        if await self.state.get_kill_switch():
            METRICS.inc("engine.alerts_suppressed_kill_switch")
            log.warning("alert_suppressed_kill_switch", opportunity_id=opp.id)
            return
        await self.bus.publish("alerts", {"kind": kind, "opportunity": opp.model_dump(mode="json")})

    async def _expire_stale_opps(self, event_id: str, mkey: str, still_active: set[str],
                                 now: datetime) -> None:
        for opp in await self.state.active_opportunities():
            if opp.event_id != event_id or opp.market_key != mkey or opp.id in still_active:
                continue
            opp.state = OppState.EXPIRED
            opp.window_s = max((now - opp.first_seen).total_seconds(), 0.0)
            opp.last_seen = now
            await self.state.upsert_opportunity(opp)
            await self.state.log_lifecycle(opp.id, opp.margin_pct, "expired", ts=now)
            await self.state.record_window(opp.timing.value, opp.window_s)
            if self.db is not None:
                await self.db.record_opportunity(opp)
            METRICS.inc("engine.opportunities_expired")
            log.info("opportunity_expired", opportunity_id=opp.id, window_s=opp.window_s,
                     peak_margin_pct=opp.peak_margin_pct)
            await self.bus.publish("opportunities", opp.model_dump(mode="json"))

    # ----------------------------------------------------------- run loop
    async def run(self) -> None:
        """Compose entrypoint: consume quotes off the bus forever."""
        async for payload in self.bus.subscribe("quotes"):
            quote = Quote.model_validate(payload)
            with METRICS.timer("engine.detect_s"):
                await self.on_quote(quote)
