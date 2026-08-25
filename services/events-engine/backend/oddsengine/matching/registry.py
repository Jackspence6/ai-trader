"""Canonical registry: teams/leagues with alias maps, canonical events, review queue.

Accepted fuzzy matches are written back to the alias tables (self-learning, spec §4).
The registry is in-memory hot state; the db layer mirrors accepted aliases and events
to Postgres when configured.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime

from ..models import CanonicalEvent, Sport, utcnow
from .normalize import normalize_name
from .seeds import LEAGUE_SEEDS, TEAM_SEEDS


@dataclass
class ReviewItem:
    id: str
    kind: str                  # team | league | event
    venue_id: str
    raw_string: str
    proposed: str | None
    confidence: float
    status: str = "pending"    # pending | accepted | rejected
    created_at: datetime = field(default_factory=utcnow)
    context: dict | None = None


class CanonicalRegistry:
    def __init__(self, seed: bool = True) -> None:
        # canonical name -> canonical id (id is the normalized canonical name)
        self.teams: dict[str, str] = {}
        self.team_aliases: dict[str, str] = {}     # normalized alias -> canonical id
        self.leagues: dict[str, str] = {}
        self.league_aliases: dict[str, str] = {}
        self.events: dict[str, CanonicalEvent] = {}
        self.reviews: dict[str, ReviewItem] = {}
        if seed:
            self._seed()

    # ------------------------------------------------------------- seeding
    def _seed(self) -> None:
        for canonical, aliases in TEAM_SEEDS.items():
            self.add_team(canonical, aliases)
        for canonical, aliases in LEAGUE_SEEDS.items():
            self.add_league(canonical, aliases)

    def add_team(self, canonical: str, aliases: list[str] | None = None) -> str:
        cid = normalize_name(canonical)
        self.teams[canonical] = cid
        self.team_aliases[cid] = cid
        self.team_aliases[normalize_name(canonical)] = cid
        for a in aliases or []:
            self.team_aliases[normalize_name(a)] = cid
        return cid

    def add_league(self, canonical: str, aliases: list[str] | None = None) -> str:
        cid = normalize_name(canonical)
        self.leagues[canonical] = cid
        self.league_aliases[cid] = cid
        for a in aliases or []:
            self.league_aliases[normalize_name(a)] = cid
        return cid

    def canonical_team_name(self, team_id: str) -> str:
        for name, cid in self.teams.items():
            if cid == team_id:
                return name
        return team_id

    def canonical_league_name(self, league_id: str | None) -> str | None:
        if league_id is None:
            return None
        for name, cid in self.leagues.items():
            if cid == league_id:
                return name
        return league_id

    # ------------------------------------------------------------- lookup
    def team_by_alias(self, raw: str) -> str | None:
        return self.team_aliases.get(normalize_name(raw))

    def league_by_alias(self, raw: str) -> str | None:
        return self.league_aliases.get(normalize_name(raw))

    def learn_team_alias(self, raw: str, team_id: str) -> None:
        self.team_aliases[normalize_name(raw)] = team_id

    def learn_league_alias(self, raw: str, league_id: str) -> None:
        self.league_aliases[normalize_name(raw)] = league_id

    # ------------------------------------------------------------- events
    @staticmethod
    def event_id_for(sport: Sport, home_id: str, away_id: str, start_time: datetime | None) -> str:
        day = start_time.strftime("%Y%m%d") if start_time else "tba"
        blob = f"{sport}|{home_id}|{away_id}|{day}"
        return hashlib.sha1(blob.encode()).hexdigest()[:12]

    def upsert_event(self, event: CanonicalEvent) -> CanonicalEvent:
        existing = self.events.get(event.id)
        if existing:
            existing.venue_refs.update(event.venue_refs)
            if event.start_time and not existing.start_time:
                existing.start_time = event.start_time
            return existing
        self.events[event.id] = event
        return event

    def event_by_venue_ref(self, venue_id: str, ref: str) -> CanonicalEvent | None:
        for ev in self.events.values():
            if ev.venue_refs.get(venue_id) == ref:
                return ev
        return None

    # ------------------------------------------------------------- reviews
    def queue_review(self, item: ReviewItem) -> None:
        self.reviews[item.id] = item

    def resolve_review(self, review_id: str, accept: bool, edited: str | None = None) -> ReviewItem | None:
        item = self.reviews.get(review_id)
        if not item:
            return None
        item.status = "accepted" if accept else "rejected"
        if accept and item.kind == "team" and (edited or item.proposed):
            self.learn_team_alias(item.raw_string, edited or item.proposed)  # type: ignore[arg-type]
        if accept and item.kind == "league" and (edited or item.proposed):
            self.learn_league_alias(item.raw_string, edited or item.proposed)  # type: ignore[arg-type]
        return item

    def pending_reviews(self) -> list[ReviewItem]:
        return [r for r in self.reviews.values() if r.status == "pending"]
