# The Event Markets engine.
#
# Reads public odds from the configured books and prediction markets, matches
# events across them, scores what crosses, and writes opportunities to the
# `events` schema the console reads. It never places a bet.
#
# Python 3.11 rather than latest: the engine supports 3.10+ so it runs on older
# boxes, and pinning here keeps the container matching what the tests run on.

FROM python:3.11-slim

WORKDIR /app

# Dependency install is its own layer so a code change does not re-resolve the
# whole tree on every build.
# constraints.txt pins the tree to the versions the engine's tests were run
# against — without it the image can be built twice a week apart and behave
# differently, with nothing in the diff to explain why.
COPY backend/pyproject.toml backend/constraints.txt ./backend/
RUN pip install --no-cache-dir -c ./backend/constraints.txt -e ./backend || true

COPY backend ./backend
RUN pip install --no-cache-dir -c ./backend/constraints.txt -e ./backend

COPY config ./config

ENV PYTHONUNBUFFERED=1

# The scheduler runs ingest, normalisation, detection and alerting in one
# process. Split them out with `docker compose run` if one needs its own cadence.
CMD ["python", "-m", "oddsengine.services.run", "scheduler"]
