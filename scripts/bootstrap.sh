#!/usr/bin/env bash
#
# From a fresh clone to a running console.
#
# Safe to re-run: every step checks before acting, and nothing here overwrites a
# secret you have already set. The last section deliberately reports what is
# missing rather than inventing defaults — a system that quietly makes up a
# database URL is a system that quietly writes to the wrong database.

set -euo pipefail

cd "$(dirname "$0")/.."
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

say "Toolchain"
node --version >/dev/null 2>&1 || { no "node is not installed (need 22+)"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] && ok "node $(node --version)" || { no "node 22+ required, found $(node --version)"; exit 1; }

if ! command -v pnpm >/dev/null 2>&1; then
  say "Installing pnpm"
  corepack enable && corepack prepare pnpm@10.33.0 --activate
fi
ok "pnpm $(pnpm --version)"

command -v docker >/dev/null 2>&1 && ok "docker present" || no "docker missing — the database and events engine need it"
command -v python3 >/dev/null 2>&1 && ok "python $(python3 --version 2>&1 | cut -d' ' -f2)" || no "python3 missing — the events engine needs it"

say "Dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "node modules installed"

say "Database"
# Docker being installed and the daemon being up are different things, and the
# second one fails in a way that used to abort the whole bootstrap before the
# build. Neither is fatal here: the console runs without a database, it just has
# no history to show.
if ! command -v docker >/dev/null 2>&1; then
  no "docker not installed — skipping. The console will run; NAV history, the capital ladder and the event board will not."
elif ! docker info >/dev/null 2>&1; then
  no "docker is installed but the daemon is not running — start Docker Desktop, then re-run this script."
else
  set +e
  docker compose up -d timescale
  UP=$?
  set -e
  if [ $UP -ne 0 ]; then
    no "docker compose failed — see above"
  else
    printf '  waiting for postgres'
    READY=0
    for _ in $(seq 1 30); do
      if docker compose exec -T timescale pg_isready -U trader -d meridian >/dev/null 2>&1; then
        READY=1; break
      fi
      printf '.'; sleep 2
    done
    printf '\n'
    if [ $READY -eq 1 ]; then
      ok "postgres up on :5433"
      set +e
      pnpm db:migrate
      MIG=$?
      set -e
      [ $MIG -eq 0 ] && ok "both desks' schemas migrated" || no "migration failed — see above"
    else
      no "postgres did not become ready in 60s"
    fi
  fi
fi

say "Events engine (Python)"
# The engine runs in Docker, so this is only needed to run its tests on the
# host. Not fatal: a box that cannot build a venv can still run the console and
# the engine container.
if ! command -v python3 >/dev/null 2>&1; then
  no 'python3 missing — skipping. pnpm test:engine will not run here.'
else
  set +e
  node scripts/setup-engine.mjs
  ENGINE=$?
  set -e
  [ $ENGINE -eq 0 ] && ok "engine packages installed for testing" || no 'engine venv failed — pnpm test:engine will not run here'
fi

say "Build"
# The webfonts are fetched at build time, so a box with no outbound network
# fails here with a font error and nothing else useful. Rather than making that
# a documented landmine, fall back to the system faces and say so — a console
# in Helvetica beats a console that would not build.
set +e
pnpm build
BUILT=$?
set -e
if [ $BUILT -ne 0 ]; then
  no "build failed — retrying with system fonts (no network needed)"
  pnpm build:offline && ok "console built with system fonts" || {
    no "build failed for a reason other than fonts — see above"
    exit 1
  }
else
  ok "console built"
fi

say "Configuration"
ENVF=".env.local"
if [ ! -f "$ENVF" ]; then
  cp .env.example "$ENVF"
  ok "created .env.local from .env.example — fill in SITE_PASSWORD before starting"
else
  ok ".env.local exists (left alone)"
fi

say "Preflight"
# The real check: try everything rather than reading configuration. Allowed to
# fail here without aborting the bootstrap, because most of what it reports is
# a capability you may not need yet.
set +e
pnpm preflight
PREFLIGHT=$?
set -e
[ $PREFLIGHT -eq 0 ] && ok "preflight clean" || no "preflight found problems — see above"

say "Next"
cat <<'TXT'
  pnpm start                              the console on :3000
  pnpm trade -- --interval 300            the Asset Markets loop — exactly one instance
  pnpm record                             the market-data recorder
  docker compose --profile events up -d   the Event Markets engine
  pnpm halt:server                        the kill switch that outlives the console

  DEPLOY.md has the systemd units for keeping all of it up.
TXT
