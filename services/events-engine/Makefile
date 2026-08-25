.PHONY: setup test lint demo report dev up down migrate logs dashboard-dev dashboard-build

setup:            ## install backend (editable) + dev tools
	pip install -e "backend[dev]"

test:             ## run unit + integration tests (§14.1 fixtures included)
	cd backend && python -m pytest -q

lint:
	cd backend && python -m ruff check oddsengine tests

demo:             ## end-to-end dry-run demo, no Docker/network needed
	cd backend && python -m oddsengine.demo

report:           ## go/no-go report from the last demo/dry-run export
	cd backend && python -m oddsengine.report runs/demo_run.json

dev:              ## simulated live feed + API on :8000 (pair with dashboard-dev)
	cd backend && python -m oddsengine.services.dev

up:               ## full stack: timescale, redis, all services, dashboard
	docker compose up -d --build

down:
	docker compose down

migrate:
	docker compose run --rm migrate

logs:
	docker compose logs -f --tail=100 engine normalizer ingest-polymarket alerter

dashboard-dev:    ## Next.js dev server on :3000
	cd dashboard && npm run dev

dashboard-build:
	cd dashboard && npm run build

scan:             ## one Polymarket scan against DATABASE_URL (add DRY=1 to write nothing)
	node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/scan-worker.mjs --once $(if $(DRY),--dry,)

scan-worker:      ## continuous Polymarket scanning (INTERVAL=60)
	node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/scan-worker.mjs --interval $(or $(INTERVAL),60)

verify:           ## everything: python tests+lint, cross-language parity, JS suites, build
	cd backend && python -m pytest -q && python -m ruff check oddsengine tests
	cd dashboard && npm run test:all && npm run build
