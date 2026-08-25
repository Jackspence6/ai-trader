"""Structured JSON logging + lightweight in-process metrics.

Every opportunity-related log line carries a correlation id (the opportunity id)
so a single arb can be traced across normalizer -> engine -> alerter.
"""

from __future__ import annotations

import logging
import sys
import time
from collections import defaultdict
from typing import Any

import structlog


def configure_logging(level: str = "INFO", json_output: bool = True) -> None:
    logging.basicConfig(stream=sys.stdout, level=getattr(logging, level.upper(), logging.INFO), format="%(message)s")
    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]
    if json_output:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer())
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level.upper(), logging.INFO)),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str, **initial: Any) -> structlog.BoundLogger:
    return structlog.get_logger(name).bind(component=name, **initial)


class Metrics:
    """Minimal counter/gauge/timer registry, exposed via the API at /metrics."""

    def __init__(self) -> None:
        self.counters: dict[str, float] = defaultdict(float)
        self.gauges: dict[str, float] = {}
        self._timings: dict[str, list[float]] = defaultdict(list)

    def inc(self, name: str, value: float = 1.0) -> None:
        self.counters[name] += value

    def gauge(self, name: str, value: float) -> None:
        self.gauges[name] = value

    def observe(self, name: str, seconds: float) -> None:
        buf = self._timings[name]
        buf.append(seconds)
        if len(buf) > 2048:
            del buf[: len(buf) - 2048]

    def timer(self, name: str) -> _Timer:
        return _Timer(self, name)

    def snapshot(self) -> dict[str, Any]:
        out: dict[str, Any] = {"counters": dict(self.counters), "gauges": dict(self.gauges), "timings": {}}
        for name, buf in self._timings.items():
            if not buf:
                continue
            ordered = sorted(buf)
            out["timings"][name] = {
                "count": len(ordered),
                "p50": ordered[len(ordered) // 2],
                "p95": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))],
                "max": ordered[-1],
            }
        return out


class _Timer:
    def __init__(self, metrics: Metrics, name: str) -> None:
        self.metrics, self.name = metrics, name

    def __enter__(self) -> _Timer:
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.metrics.observe(self.name, time.perf_counter() - self.t0)


METRICS = Metrics()
