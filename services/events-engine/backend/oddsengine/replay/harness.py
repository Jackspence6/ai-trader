"""Record/replay harness (spec §10): capture raw bus traffic to JSONL, replay it
later through the pipeline for backtesting, regression tests and load tests.

Record (tee alongside a live run):
    recorder = Recorder(bus, "runs/capture.jsonl"); await recorder.run()
Replay:
    python -m oddsengine.replay.harness runs/capture.jsonl --speed 10
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime
from pathlib import Path

from ..models import utcnow
from ..observability import get_logger

log = get_logger("replay")

RAW_TOPICS = ("raw_events", "raw_markets", "raw_odds", "health")


class Recorder:
    def __init__(self, bus, path: str | Path) -> None:
        self.bus = bus
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    async def run(self) -> None:
        with self.path.open("a") as fh:
            async def _tee(topic: str) -> None:
                async for payload in self.bus.subscribe(topic):
                    fh.write(json.dumps({"ts": utcnow().isoformat(), "topic": topic,
                                         "payload": payload}, default=str) + "\n")
                    fh.flush()
            await asyncio.gather(*(_tee(t) for t in RAW_TOPICS))


class Player:
    def __init__(self, bus, path: str | Path, speed: float = 1.0) -> None:
        self.bus = bus
        self.path = Path(path)
        self.speed = max(speed, 0.01)

    async def run(self) -> int:
        prev_ts: datetime | None = None
        count = 0
        for line in self.path.read_text().splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            ts = datetime.fromisoformat(rec["ts"])
            if prev_ts is not None:
                delay = (ts - prev_ts).total_seconds() / self.speed
                if delay > 0:
                    await asyncio.sleep(min(delay, 5.0))
            prev_ts = ts
            await self.bus.publish(rec["topic"], rec["payload"])
            count += 1
        log.info("replay_complete", messages=count)
        return count


async def _main() -> None:
    from ..bus import MemoryBus
    parser = argparse.ArgumentParser()
    parser.add_argument("capture")
    parser.add_argument("--speed", type=float, default=10.0)
    args = parser.parse_args()
    bus = MemoryBus()
    n = await Player(bus, args.capture, args.speed).run()
    print(f"replayed {n} messages (attach services to the bus for full backtests)")


if __name__ == "__main__":
    asyncio.run(_main())
