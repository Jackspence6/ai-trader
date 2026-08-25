"""OddsEngine — measurement-first SA sportsbook + Polymarket arbitrage engine.

Phase 1: ingest -> normalize/match -> detect -> score -> alert -> measure.
No automated bookmaker bet placement. Polymarket ingestion is read-only;
execution is stubbed behind a dry-run flag (see venues/polymarket/execution.py).
"""

__version__ = "0.1.0"
