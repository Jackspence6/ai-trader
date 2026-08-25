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
if command -v docker >/dev/null 2>&1; then
  docker compose up -d timescale
  printf '  waiting for postgres'
  for _ in $(seq 1 30); do
    if docker compose exec -T timescale pg_isready -U trader -d meridian >/dev/null 2>&1; then
      printf '\n'; ok "postgres up on :5433"; break
    fi
    printf '.'; sleep 2
  done
  pnpm db:migrate && ok "both desks' schemas migrated"
else
  no "skipped — no docker"
fi

say "Build"
pnpm build && ok "console built"

say "What is still unset"
ENVF=".env.local"
[ -f "$ENVF" ] || { touch "$ENVF"; }
check_env() {
  if grep -q "^$1=" "$ENVF" 2>/dev/null || [ -n "${!1:-}" ]; then ok "$1"; else no "$1 — $2"; fi
}
check_env SITE_PASSWORD    "the console fails closed without it and will not serve"
check_env DATABASE_URL     "postgresql://trader:trader@localhost:5433/meridian"
check_env TELEGRAM_BOT_TOKEN "optional — alerts are logged, not sent, until this is set"
check_env ADMIN_TOKEN      "optional — gates the events desk's migration endpoint"

say "Next"
cat <<'TXT'
  pnpm start                              the console on :3000
  pnpm trade -- --interval 300            the Asset Markets loop — exactly one instance
  pnpm record                             the market-data recorder
  docker compose --profile events up -d   the Event Markets engine
  pnpm halt:server                        the kill switch that outlives the console

  DEPLOY.md has the systemd units for keeping all of it up.
TXT
