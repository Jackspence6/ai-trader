"""HAR analyser: turn a browser capture into a venue adapter config.

The spec's §3.2 discovery procedure ends with a human squinting at DevTools to work
out which XHR actually carries the odds. That step is mechanical, so this does it:

    python -m oddsengine.discovery capture.har --venue betway_sa

Give it a HAR exported from Chrome while browsing a sportsbook and it scores every
JSON response for how much it looks like an odds feed — decimal-odds-shaped numbers,
repeated selection structures, team/market/price key names, event timestamps — then
prints the ranked candidates, a ready-to-paste `config/venues.yaml` block, and a
sketch of the payload shape to write `parse_odds` against.

It does not fabricate anything: every endpoint it reports came out of the operator's
own capture. If the capture contains no odds-shaped JSON, it says so.

Privacy: HAR files record whatever the browser sent, cookies and auth headers
included. This tool reads locally, never uploads, redacts credential-bearing headers
in its output, and refuses to print request bodies.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Header names whose values must never be echoed into a config file or the terminal.
SENSITIVE_HEADERS = {
    "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
    "x-session-id", "x-csrf-token", "proxy-authorization",
}

#: Key names that suggest a betting payload. Weighted: some are far more telling.
ODDS_KEY_HINTS = {
    "odds": 6, "price": 4, "decimal": 5, "decimalodds": 8, "americanodds": 5,
    "fractional": 4, "selection": 5, "selections": 6, "outcome": 5, "outcomes": 6,
    "market": 4, "markets": 5, "betoffer": 8, "betoffers": 8, "runner": 4,
    "runners": 5, "event": 3, "events": 4, "fixture": 4, "fixtures": 5,
    "competitor": 3, "hometeam": 4, "awayteam": 4, "participant": 3,
    "handicap": 4, "line": 2, "suspended": 4, "starttime": 3, "kickoff": 4,
}

#: Endpoints that are never odds and shouldn't waste the operator's attention.
NOISE_PATH_RE = re.compile(
    r"(analytics|telemetry|metric|tracking|gtm|gtag|sentry|hotjar|segment|"
    r"\.(png|jpe?g|gif|svg|webp|woff2?|ttf|css|ico|mp4)$)",
    re.IGNORECASE,
)

#: Decimal odds live here. Values outside it are prices, ids, or timestamps.
DECIMAL_ODDS_RANGE = (1.01, 1001.0)
#: Kambi and friends send milli-decimal integers (2100 == 2.10).
MILLI_ODDS_RANGE = (1010, 1_001_000)


@dataclass
class Candidate:
    url: str
    host: str
    path: str
    method: str
    status: int
    score: float
    odds_like_values: int
    matched_keys: list[str]
    content_type: str
    body_bytes: int
    sample_shape: str
    is_websocket: bool = False
    auth_headers: list[str] = field(default_factory=list)
    milli_format: bool = False

    @property
    def redacted_headers(self) -> list[str]:
        return sorted(self.auth_headers)


#: Yielded as the value for a key whose content is a container. Container key names
#: ("selections", "betOffers", "markets") are the strongest naming signal there is,
#: so they must be counted — but they are not values, so they never score as odds.
CONTAINER = object()


def _walk(obj: Any, depth: int = 0, max_depth: int = 8):
    """Yield (key, value) for every entry in a nested structure.

    Container-valued keys yield CONTAINER so key naming is scored without their
    contents being mistaken for prices.
    """
    if depth > max_depth:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                yield str(k).lower(), CONTAINER
                yield from _walk(v, depth + 1, max_depth)
            else:
                yield str(k).lower(), v
    elif isinstance(obj, list):
        for v in obj[:200]:          # a long list adds no new shape information
            yield from _walk(v, depth + 1, max_depth)


def looks_like_decimal_odds(v: Any) -> bool:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    return DECIMAL_ODDS_RANGE[0] <= float(v) <= DECIMAL_ODDS_RANGE[1] and float(v) != int(v)


def looks_like_milli_odds(v: Any) -> bool:
    if isinstance(v, bool) or not isinstance(v, int):
        return False
    return MILLI_ODDS_RANGE[0] <= v <= MILLI_ODDS_RANGE[1]


def describe_shape(obj: Any, depth: int = 0, max_depth: int = 3) -> str:
    """A compact type sketch of a payload, for writing a parser against."""
    pad = "  " * depth
    if depth > max_depth:
        return f"{pad}..."
    if isinstance(obj, dict):
        lines = []
        for k, v in list(obj.items())[:8]:
            if isinstance(v, (dict, list)):
                lines.append(f"{pad}{k}:")
                lines.append(describe_shape(v, depth + 1, max_depth))
            else:
                lines.append(f"{pad}{k}: {type(v).__name__} = {json.dumps(v)[:40]}")
        if len(obj) > 8:
            lines.append(f"{pad}... {len(obj) - 8} more keys")
        return "\n".join(lines)
    if isinstance(obj, list):
        if not obj:
            return f"{pad}[] (empty)"
        return f"{pad}[{len(obj)} x]\n" + describe_shape(obj[0], depth + 1, max_depth)
    return f"{pad}{type(obj).__name__}"


def score_payload(payload: Any) -> tuple[float, int, list[str], bool]:
    """Score how much a decoded JSON body looks like an odds feed."""
    key_counter: Counter[str] = Counter()
    odds_like = 0
    milli_like = 0

    for key, value in _walk(payload):
        flat = key.replace("_", "").replace("-", "")
        if flat in ODDS_KEY_HINTS:
            key_counter[flat] += 1
        if looks_like_decimal_odds(value):
            odds_like += 1
        elif looks_like_milli_odds(value):
            milli_like += 1

    key_score = sum(ODDS_KEY_HINTS[k] * min(count, 5) for k, count in key_counter.items())
    # Many odds-shaped numbers is the strongest single signal.
    value_score = min(odds_like, 200) * 1.5 + min(milli_like, 200) * 1.0
    milli_format = milli_like > odds_like * 2 and milli_like >= 3

    return key_score + value_score, odds_like + milli_like, sorted(key_counter), milli_format


def analyse_har(har_path: Path, min_score: float = 20.0, limit: int = 15) -> list[Candidate]:
    data = json.loads(har_path.read_text(encoding="utf-8", errors="replace"))
    entries = data.get("log", {}).get("entries", [])
    candidates: list[Candidate] = []

    for entry in entries:
        request = entry.get("request", {})
        response = entry.get("response", {})
        url = request.get("url", "")
        if not url or NOISE_PATH_RE.search(url):
            continue

        parsed = urlparse(url)
        content = response.get("content", {}) or {}
        mime = (content.get("mimeType") or "").lower()
        text = content.get("text") or ""
        is_ws = parsed.scheme in ("ws", "wss") or bool(entry.get("_webSocketMessages"))

        payloads: list[Any] = []
        if is_ws:
            for msg in (entry.get("_webSocketMessages") or [])[:50]:
                raw = msg.get("data")
                if not raw:
                    continue
                try:
                    payloads.append(json.loads(raw))
                except (json.JSONDecodeError, TypeError):
                    continue
        elif "json" in mime or text.strip()[:1] in ("{", "["):
            try:
                payloads.append(json.loads(text))
            except (json.JSONDecodeError, TypeError):
                continue
        if not payloads:
            continue

        best = (0.0, 0, [], False)
        best_payload = payloads[0]
        for p in payloads:
            s = score_payload(p)
            if s[0] > best[0]:
                best, best_payload = s, p
        score, odds_like, keys, milli = best
        if score < min_score:
            continue

        auth = [h.get("name", "") for h in request.get("headers", [])
                if h.get("name", "").lower() in SENSITIVE_HEADERS]

        candidates.append(Candidate(
            url=url, host=parsed.netloc, path=parsed.path, method=request.get("method", "GET"),
            status=response.get("status", 0), score=round(score, 1), odds_like_values=odds_like,
            matched_keys=keys, content_type=mime, body_bytes=len(text),
            sample_shape=describe_shape(best_payload), is_websocket=is_ws,
            auth_headers=auth, milli_format=milli,
        ))

    candidates.sort(key=lambda c: c.score, reverse=True)

    # Collapse repeats of the same endpoint (polling produces many identical calls).
    seen: set[tuple[str, str]] = set()
    unique: list[Candidate] = []
    for c in candidates:
        key = (c.host, re.sub(r"\d+", "{id}", c.path))
        if key in seen:
            continue
        seen.add(key)
        unique.append(c)
    return unique[:limit]


def suggest_config(venue_id: str, candidates: list[Candidate]) -> str:
    """A venues.yaml block the operator can paste, built only from real captures."""
    if not candidates:
        return (
            f"# No odds-shaped JSON found for {venue_id}.\n"
            f"# Re-capture with the Network tab open while odds are visibly updating,\n"
            f"# and make sure 'Preserve log' is on.\n"
        )
    http = [c for c in candidates if not c.is_websocket] or candidates
    top = http[0]
    ws = next((c for c in candidates if c.is_websocket), None)

    # An odds_url is one that carries an event id we can template out. Prefer the
    # highest-scoring such endpoint, which is rarely the same as the listing call.
    per_event = next(
        (c for c in http if re.search(r"/\d{4,}(?:/|$|\?)", c.url)), None)
    templated = re.sub(r"/\d{4,}", "/{event_ref}", per_event.url) if per_event else None

    # Any endpoint in the capture needing credentials is worth surfacing, not just
    # the top one — the odds call often authenticates while the listing does not.
    auth_headers = sorted({h for c in http for h in c.redacted_headers})
    milli = any(c.milli_format for c in http)

    lines = [
        f"# Suggested from your HAR capture — {len(candidates)} candidate endpoint(s).",
        "# Verify each URL in the browser before enabling; templating is a guess.",
        "venues:",
        f"  {venue_id}:",
        "    enabled: false          # flip once parse_events/parse_odds are written",
        "    min_interval_s: 20",
        "    endpoints:",
        f"      events_url: \"{top.url}\"",
    ]
    if templated:
        lines.append(f"      odds_url: \"{templated}\"   # {{event_ref}} substituted where an id appeared")
    if ws:
        lines.append(f"      ws_url: \"{ws.url}\"")
    if auth_headers:
        lines.append("      headers:")
        for h in auth_headers:
            lines.append(f"        {h}: \"<REDACTED — copy the value from your own browser>\"")
    if milli:
        lines.append("    # Odds appear to be milli-decimal integers (2100 == 2.10) —")
        lines.append("    # venues/kambi.py's milli_odds() already handles that format.")
    return "\n".join(lines) + "\n"


def render_report(venue_id: str, candidates: list[Candidate], show_shapes: int = 2) -> str:
    out: list[str] = []
    out.append(f"\nHAR analysis for '{venue_id}' — {len(candidates)} candidate endpoint(s)\n")
    if not candidates:
        out.append(
            "  Nothing in this capture looks like an odds feed.\n\n"
            "  Common causes:\n"
            "    - the capture was taken before odds loaded (browse an in-play event, then export)\n"
            "    - 'Preserve log' was off and the navigation cleared the entries\n"
            "    - the site renders odds server-side (then Playwright is the path, not an API)\n",
        )
        return "".join(out)

    out.append(f"  {'score':>7}  {'odds#':>6}  {'kind':<5}  endpoint\n")
    out.append(f"  {'-' * 7}  {'-' * 6}  {'-' * 5}  {'-' * 60}\n")
    for c in candidates:
        kind = "WS" if c.is_websocket else c.method
        url = c.url if len(c.url) <= 78 else c.url[:75] + "..."
        out.append(f"  {c.score:>7.1f}  {c.odds_like_values:>6}  {kind:<5}  {url}\n")
        if c.matched_keys:
            out.append(f"           keys: {', '.join(c.matched_keys[:10])}\n")
        if c.auth_headers:
            out.append(f"           ⚠ requires headers: {', '.join(c.redacted_headers)} (values redacted)\n")
        if c.milli_format:
            out.append("           odds look milli-decimal (2100 == 2.10)\n")

    for c in candidates[:show_shapes]:
        out.append(f"\n  ── payload shape: {c.path} ──\n")
        for line in c.sample_shape.splitlines()[:24]:
            out.append(f"    {line}\n")

    out.append("\n" + suggest_config(venue_id, candidates))
    out.append(
        "\nNext: write parse_events/parse_odds against the shape above in the venue's\n"
        "adapter, add a fixture test from a saved payload, then flip enabled: true.\n"
        "Conduct rules still apply — public odds pages only, never account endpoints.\n",
    )
    return "".join(out)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Find the odds endpoints in a browser HAR capture (spec §3.2).")
    parser.add_argument("har", type=Path, help="HAR file exported from the browser's Network tab")
    parser.add_argument("--venue", default="new_venue", help="venue id for the suggested config block")
    parser.add_argument("--min-score", type=float, default=20.0)
    parser.add_argument("--limit", type=int, default=15)
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    if not args.har.exists():
        raise SystemExit(f"no such file: {args.har}")

    candidates = analyse_har(args.har, args.min_score, args.limit)

    if args.json:
        print(json.dumps([{
            "url": c.url, "host": c.host, "path": c.path, "method": c.method,
            "score": c.score, "odds_like_values": c.odds_like_values,
            "matched_keys": c.matched_keys, "is_websocket": c.is_websocket,
            "requires_headers": c.redacted_headers, "milli_format": c.milli_format,
        } for c in candidates], indent=2))
    else:
        print(render_report(args.venue, candidates))


if __name__ == "__main__":
    main()
