"""USDZAR conversion with a risk buffer (spec §5: 'convert to ZAR live with a risk buffer').

Polymarket legs are USD/USDC (pUSD since CLOB V2). All stake math is done in ZAR;
PM leg capacity is converted at a *buffered* rate so an adverse FX move over the
holding window cannot silently turn a thin arb negative.

Buffer direction: when converting a USD payout/capacity into ZAR we haircut the rate
(divide by 1+buffer); when estimating the ZAR cost of a USD stake we inflate it.
"""

from __future__ import annotations

import time

import httpx

from .config import FxConfig
from .observability import get_logger

log = get_logger("fx")


class FxService:
    def __init__(self, cfg: FxConfig) -> None:
        self.cfg = cfg
        self._rate: float = cfg.fallback_rate
        self._fetched_at: float = 0.0
        self._live: bool = False

    @property
    def rate(self) -> float:
        """Latest known USDZAR mid rate (fallback if no live fetch succeeded)."""
        return self._rate

    @property
    def is_live(self) -> bool:
        return self._live

    def set_rate(self, rate: float, live: bool = True) -> None:
        if rate <= 0:
            raise ValueError("FX rate must be positive")
        self._rate = rate
        self._live = live
        self._fetched_at = time.time()

    @property
    def buffered_rate(self) -> float:
        """Conservative rate for valuing USD-side payouts in ZAR."""
        return self._rate / (1.0 + self.cfg.buffer_pct / 100.0)

    def usd_to_zar(self, usd: float, conservative: bool = True) -> float:
        return usd * (self.buffered_rate if conservative else self._rate)

    def zar_to_usd(self, zar: float, conservative: bool = True) -> float:
        # Conservative = assume we need MORE USD than mid implies
        rate = self.buffered_rate if conservative else self._rate
        return zar / rate

    async def refresh(self, client: httpx.AsyncClient | None = None) -> bool:
        """Fetch a live rate. Returns True on success; keeps last-known rate on failure."""
        own = client is None
        client = client or httpx.AsyncClient(timeout=10)
        try:
            resp = await client.get(self.cfg.provider_url)
            resp.raise_for_status()
            data = resp.json()
            rate = float(data["rates"]["ZAR"])
            self.set_rate(rate, live=True)
            log.info("fx_refreshed", rate=rate)
            return True
        except Exception as exc:  # noqa: BLE001 — FX outage is an expected chaos case
            log.warning("fx_refresh_failed", error=str(exc), using=self._rate, live=self._live)
            return False
        finally:
            if own:
                await client.aclose()
