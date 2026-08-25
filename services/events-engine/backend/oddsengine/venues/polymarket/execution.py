"""POLYMARKET_EXECUTION capability — STUBBED (spec §1: Phase 1 is alert-only).

Hard requirements when Phase 3 turns this on:
- Use `py-clob-client-v2` (CLOB V2 hard cutover 2026-04-28: pUSD collateral, new
  order signing; the legacy client is retired).
- Signed orders MUST include `feeRateBps` (read live from /fee-rate, never the docs table).
- negRisk markets settle through a different exchange contract and require
  `negRisk: true` on orders; split/merge is 1 pUSD <-> 1 YES + 1 NO and the
  NegRiskAdapter "convert" moves capital across complement sets.
- Wallet keys live ONLY in this (later) execution service, never in scrapers (spec §11).
- The 500ms taker delay is gone (2026-02-18): latency is the only moat, which is why
  Phase 1 measures live arbs instead of chasing them.
"""

from __future__ import annotations

from dataclasses import dataclass

from ...observability import get_logger

log = get_logger("polymarket.execution")


@dataclass
class OrderIntent:
    token_id: str
    side: str          # BUY | SELL
    price: float
    size_shares: float
    fee_rate_bps: int
    neg_risk: bool


class ExecutionDisabled(RuntimeError):
    pass


class PolymarketExecutor:
    """Dry-run only. Every call logs the would-be order; nothing is ever sent."""

    CAPABILITY = "POLYMARKET_EXECUTION"

    def __init__(self, dry_run: bool = True) -> None:
        if not dry_run:
            raise ExecutionDisabled(
                "Automated Polymarket execution is Phase 3. This build is measurement-first: "
                "set dry_run=True (the only supported mode) or implement the py-clob-client-v2 "
                "integration behind explicit operator opt-in."
            )
        self.dry_run = True

    async def place(self, intent: OrderIntent) -> dict:
        log.info(
            "dry_run_order", token_id=intent.token_id[:16], side=intent.side,
            price=intent.price, size=intent.size_shares, fee_rate_bps=intent.fee_rate_bps,
            neg_risk=intent.neg_risk,
        )
        return {"status": "dry_run", "intent": intent.__dict__}
