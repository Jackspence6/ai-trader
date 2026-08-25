"""Defensive parsers for Polymarket payloads.

Known sharp edges (spec §3.4): prices arrive as JSON *strings*; array fields
(outcomePrices, clobTokenIds, outcomes) are often a JSON-encoded string rather
than a JSON array; bid/ask array ordering must never be trusted; negRisk flags
can be missing. Explicit tests live in tests/test_polymarket_parsing.py.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ...models import BookLevel


def as_list(value: Any) -> list[Any]:
    """Gamma frequently returns list fields as a JSON-encoded string."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def as_float(value: Any, default: float | None = None) -> float | None:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


@dataclass
class ParsedMarket:
    condition_id: str
    question: str
    slug: str
    outcomes: list[str]
    outcome_prices: list[float]
    token_ids: list[str]
    neg_risk: bool
    closed: bool
    category: str | None = None
    game_start_time: str | None = None
    end_date: str | None = None
    event_id: str | None = None
    event_title: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def parse_gamma_market(m: dict[str, Any], event: dict[str, Any] | None = None) -> ParsedMarket | None:
    token_ids = [str(t) for t in as_list(m.get("clobTokenIds"))]
    outcomes = [str(o) for o in as_list(m.get("outcomes"))]
    prices = [as_float(p, 0.0) or 0.0 for p in as_list(m.get("outcomePrices"))]
    condition_id = str(m.get("conditionId") or m.get("condition_id") or m.get("id") or "")
    if not condition_id or not token_ids:
        return None
    category = m.get("category") or (event or {}).get("category")
    tags = [t.get("slug") if isinstance(t, dict) else str(t) for t in as_list((event or {}).get("tags"))]
    if not category and tags:
        category = tags[0]
    return ParsedMarket(
        condition_id=condition_id,
        question=str(m.get("question") or m.get("title") or ""),
        slug=str(m.get("slug") or (event or {}).get("slug") or ""),
        outcomes=outcomes,
        outcome_prices=prices,
        token_ids=token_ids,
        neg_risk=as_bool(m.get("negRisk") if m.get("negRisk") is not None else (event or {}).get("negRisk")),
        closed=as_bool(m.get("closed")),
        category=str(category).lower() if category else None,
        game_start_time=m.get("gameStartTime") or (event or {}).get("startDate"),
        end_date=m.get("endDate") or (event or {}).get("endDate"),
        event_id=str((event or {}).get("id")) if event else None,
        event_title=str((event or {}).get("title") or "") if event else None,
        raw=m,
    )


@dataclass
class ParsedBook:
    token_id: str
    bids: list[BookLevel]   # sorted best (highest) first
    asks: list[BookLevel]   # sorted best (lowest) first

    @property
    def best_bid(self) -> float | None:
        return self.bids[0].price if self.bids else None

    @property
    def best_ask(self) -> float | None:
        return self.asks[0].price if self.asks else None


def _levels(raw_levels: Any) -> list[BookLevel]:
    out: list[BookLevel] = []
    for lvl in as_list(raw_levels):
        if isinstance(lvl, dict):
            price, size = as_float(lvl.get("price")), as_float(lvl.get("size"))
        elif isinstance(lvl, (list, tuple)) and len(lvl) >= 2:
            price, size = as_float(lvl[0]), as_float(lvl[1])
        else:
            continue
        if price is None or size is None or price <= 0 or size <= 0:
            continue
        out.append(BookLevel(price=price, size=size))
    return out


def parse_book(payload: dict[str, Any]) -> ParsedBook | None:
    """Parse a CLOB REST book or WS 'book' message. NEVER trust incoming ordering —
    always re-sort (side inversion is an easy, silent corruption)."""
    token_id = str(payload.get("asset_id") or payload.get("token_id") or payload.get("market") or "")
    if not token_id:
        return None
    bids = sorted(_levels(payload.get("bids") or payload.get("buys")), key=lambda x: -x.price)
    asks = sorted(_levels(payload.get("asks") or payload.get("sells")), key=lambda x: x.price)
    # Sanity: a crossed book (best bid > best ask) means we inverted sides or got garbage.
    if bids and asks and bids[0].price > asks[0].price:
        return None
    return ParsedBook(token_id=token_id, bids=bids, asks=asks)


def parse_ws_messages(raw: str | bytes) -> list[dict[str, Any]]:
    """WS frames may be a single object or an array of objects."""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if isinstance(data, dict):
        return [data]
    if isinstance(data, list):
        return [d for d in data if isinstance(d, dict)]
    return []


def parse_fee_rate(payload: Any, fallback: float) -> float:
    """Parse the /fee-rate response. Historically docs and endpoint disagreed — the
    endpoint wins. Accept bps or fraction spellings; >1 values are treated as bps."""
    if payload is None:
        return fallback
    if isinstance(payload, (int, float, str)):
        v = as_float(payload)
        if v is None:
            return fallback
        return v / 10_000.0 if v > 1.0 else v
    if isinstance(payload, dict):
        for key in ("fee_rate_bps", "feeRateBps", "taker_fee_bps", "takerFeeBps",
                    "fee_rate", "feeRate", "taker"):
            if key in payload:
                v = as_float(payload[key])
                if v is None:
                    continue
                return v / 10_000.0 if (("bps" in key.lower()) or v > 1.0) else v
    return fallback
