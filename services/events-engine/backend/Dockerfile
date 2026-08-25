FROM python:3.11-slim

WORKDIR /app

# Playwright is NOT installed by default (only the hollywoodbets fallback needs it):
#   docker build --build-arg INSTALL_SCRAPE=1 ...
ARG INSTALL_SCRAPE=0

COPY pyproject.toml ./
COPY oddsengine ./oddsengine

RUN pip install --no-cache-dir . \
    && if [ "$INSTALL_SCRAPE" = "1" ]; then \
         pip install --no-cache-dir ".[scrape]" && playwright install --with-deps chromium; \
       fi

ENV PYTHONUNBUFFERED=1
CMD ["uvicorn", "oddsengine.services.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
