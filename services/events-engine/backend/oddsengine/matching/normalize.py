"""Team/player/league string normalization ahead of fuzzy matching (spec §4)."""

from __future__ import annotations

import re
import unicodedata

NOISE_TOKENS = {
    "fc", "afc", "cf", "sc", "ac", "rc", "club", "the", "de", "cd", "if", "fk", "bk",
}

# Sponsor prefixes common in SA competitions ("Vodacom Bulls", "DHL Stormers", "Hollywoodbets Sharks")
SPONSOR_TOKENS = {
    "vodacom", "dhl", "hollywoodbets", "emirates", "toyota", "betway", "airlink", "fidelity",
    "suzuki", "sekhukhune?",  # never strip real identity tokens; keep list tight
}

ABBREVIATIONS = {
    "man utd": "manchester united",
    "man united": "manchester united",
    "man city": "manchester city",
    "utd": "united",
    "gsw": "golden state warriors",
    "okc": "oklahoma city thunder",
    "psg": "paris saint germain",
    "spurs": "tottenham hotspur",
}


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def normalize_name(raw: str) -> str:
    s = strip_accents(raw or "").lower().strip()
    s = re.sub(r"[.’']", "", s)
    s = re.sub(r"[^a-z0-9\s-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    for abbr, full in ABBREVIATIONS.items():
        if s == abbr:
            s = full
            break
    tokens = [t for t in s.split() if t not in NOISE_TOKENS]
    # Drop a leading sponsor token only when something meaningful remains.
    if len(tokens) > 1 and tokens[0] in SPONSOR_TOKENS:
        tokens = tokens[1:]
    return " ".join(tokens) if tokens else s


VS_SPLIT = re.compile(r"\s+(?:vs\.?|v\.?|—|-)\s+", re.IGNORECASE)


def split_matchup(title: str) -> tuple[str, str] | None:
    """Split 'Lakers vs. Celtics' / 'Sundowns v Pirates' style titles into two sides."""
    if not title:
        return None
    parts = VS_SPLIT.split(title.strip(), maxsplit=1)
    if len(parts) == 2 and all(p.strip() for p in parts):
        left, right = parts[0].strip(), parts[1].strip()
        # PM questions often carry a trailing clause: "Lakers vs. Celtics: who wins?"
        right = re.split(r"[:?(]", right)[0].strip()
        if left and right:
            return left, right
    return None
