"""Cross-venue event matching (spec §4).

Keys: (sport, canonical_home, canonical_away, start_time ± tolerance); confidence from
rapidfuzz token_set + partial ratio over normalized strings. Auto-accept >= 0.92,
review 0.75–0.92, reject < 0.75. Accepted pairs are written back to alias tables.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta

from rapidfuzz import fuzz

from ..config import MatchingConfig
from ..models import CanonicalEvent, RawEvent
from ..observability import get_logger
from .normalize import normalize_name, split_matchup
from .registry import CanonicalRegistry, ReviewItem

log = get_logger("matcher")


def name_confidence(a: str, b: str) -> float:
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    token_set = fuzz.token_set_ratio(na, nb) / 100.0
    partial = fuzz.partial_ratio(na, nb) / 100.0
    return 0.6 * token_set + 0.4 * partial


@dataclass
class MatchDecision:
    event: CanonicalEvent | None
    confidence: float
    action: str          # matched | created | review | rejected
    review_id: str | None = None


class EventMatcher:
    def __init__(self, registry: CanonicalRegistry, cfg: MatchingConfig) -> None:
        self.registry = registry
        self.cfg = cfg

    # ---------------------------------------------------------------- teams
    def resolve_side(self, venue_id: str, raw: str) -> tuple[str | None, float]:
        """Resolve one side to a canonical team id: alias hit, else fuzzy over known teams."""
        hit = self.registry.team_by_alias(raw)
        if hit:
            return hit, 1.0
        best_id, best_conf = None, 0.0
        for canonical, cid in self.registry.teams.items():
            conf = name_confidence(raw, canonical)
            if conf > best_conf:
                best_id, best_conf = cid, conf
        if best_id and best_conf >= self.cfg.auto_accept:
            self.registry.learn_team_alias(raw, best_id)  # self-learning
            log.info("alias_learned", venue=venue_id, raw=raw, team=best_id, conf=round(best_conf, 3))
            return best_id, best_conf
        if best_id and best_conf >= self.cfg.review_min:
            item = ReviewItem(
                id=uuid.uuid4().hex[:10], kind="team", venue_id=venue_id, raw_string=raw,
                proposed=best_id, confidence=best_conf,
            )
            self.registry.queue_review(item)
            return None, best_conf
        return None, best_conf

    # ---------------------------------------------------------------- events
    def match(self, raw: RawEvent) -> MatchDecision:
        # Already linked?
        linked = self.registry.event_by_venue_ref(raw.venue_id, raw.ref)
        if linked:
            return MatchDecision(linked, 1.0, "matched")

        home_raw, away_raw = raw.home_raw, raw.away_raw
        if (not home_raw or not away_raw) and raw.title_raw:
            pair = split_matchup(raw.title_raw)
            if pair:
                home_raw, away_raw = pair
        if not home_raw or not away_raw:
            return MatchDecision(None, 0.0, "rejected")

        home_id, hconf = self.resolve_side(raw.venue_id, home_raw)
        away_id, aconf = self.resolve_side(raw.venue_id, away_raw)

        # Unknown teams: try matching against existing events fuzzily before creating.
        tolerance = timedelta(minutes=(
            self.cfg.pm_start_tolerance_min if raw.extra.get("date_bracketed") else self.cfg.start_tolerance_min
        ))
        candidate, cand_conf = self._closest_event(raw, home_raw, away_raw, tolerance)
        if candidate and cand_conf >= self.cfg.auto_accept:
            candidate.venue_refs[raw.venue_id] = raw.ref
            if home_id is None:
                self.registry.learn_team_alias(home_raw, candidate.home or normalize_name(home_raw))
            if away_id is None:
                self.registry.learn_team_alias(away_raw, candidate.away or normalize_name(away_raw))
            return MatchDecision(candidate, cand_conf, "matched")

        if home_id and away_id:
            # Direction check: venues can list home/away flipped (esp. PM titles).
            eid = self.registry.event_id_for(raw.sport, home_id, away_id, raw.start_time)
            eid_flipped = self.registry.event_id_for(raw.sport, away_id, home_id, raw.start_time)
            existing = self.registry.events.get(eid) or self.registry.events.get(eid_flipped)
            if existing and self._time_close(existing, raw, tolerance):
                existing.venue_refs[raw.venue_id] = raw.ref
                return MatchDecision(existing, min(hconf, aconf), "matched")
            league_id = self.registry.league_by_alias(raw.league_raw) if raw.league_raw else None
            if raw.league_raw and league_id is None:
                league_id = normalize_name(raw.league_raw)
                self.registry.learn_league_alias(raw.league_raw, league_id)
            event = CanonicalEvent(
                id=eid, sport=raw.sport,
                league=self.registry.canonical_league_name(league_id),
                home=self.registry.canonical_team_name(home_id),
                away=self.registry.canonical_team_name(away_id),
                start_time=raw.start_time, venue_refs={raw.venue_id: raw.ref},
            )
            self.registry.upsert_event(event)
            return MatchDecision(event, min(hconf, aconf), "created")

        if candidate and cand_conf >= self.cfg.review_min:
            item = ReviewItem(
                id=uuid.uuid4().hex[:10], kind="event", venue_id=raw.venue_id,
                raw_string=f"{home_raw} vs {away_raw}", proposed=candidate.id, confidence=cand_conf,
                context={"start_time": str(raw.start_time)},
            )
            self.registry.queue_review(item)
            return MatchDecision(None, cand_conf, "review", review_id=item.id)

        # Teams unknown everywhere: create a provisional canonical event from raw names so
        # single-venue coverage still flows (it can never arb until a second venue matches).
        hid = self.registry.add_team(home_raw)
        aid = self.registry.add_team(away_raw)
        eid = self.registry.event_id_for(raw.sport, hid, aid, raw.start_time)
        event = CanonicalEvent(
            id=eid, sport=raw.sport, league=raw.league_raw, home=home_raw, away=away_raw,
            start_time=raw.start_time, venue_refs={raw.venue_id: raw.ref},
        )
        self.registry.upsert_event(event)
        return MatchDecision(event, max(hconf, aconf, 0.5), "created")

    def _time_close(self, event: CanonicalEvent, raw: RawEvent, tolerance: timedelta) -> bool:
        if event.start_time is None or raw.start_time is None:
            return True
        return abs(event.start_time - raw.start_time) <= tolerance

    def _closest_event(self, raw: RawEvent, home_raw: str, away_raw: str,
                       tolerance: timedelta) -> tuple[CanonicalEvent | None, float]:
        best, best_conf = None, 0.0
        for ev in self.registry.events.values():
            if ev.sport != raw.sport or not ev.home or not ev.away:
                continue
            if not self._time_close(ev, raw, tolerance):
                continue
            straight = min(name_confidence(home_raw, ev.home), name_confidence(away_raw, ev.away))
            flipped = min(name_confidence(home_raw, ev.away), name_confidence(away_raw, ev.home))
            conf = max(straight, flipped)
            if conf > best_conf:
                best, best_conf = ev, conf
        return best, best_conf
