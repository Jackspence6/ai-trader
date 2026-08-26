# Quick start

Assumes a machine with Node 22+, Docker, and Python 3.11+. Nothing else.

```sh
git clone <repo> meridian && cd meridian
./scripts/bootstrap.sh
```

The script checks the toolchain, installs dependencies, brings up Postgres,
migrates both desks' schemas, builds the console, creates `.env.local` from the
example, and finishes by running preflight. It is safe to re-run and it does not
overwrite an `.env.local` that already exists.

Then set one value:

```sh
# .env.local
SITE_PASSWORD=<anything you will remember>
```

The console refuses to serve a single page without it. That is deliberate: a
missing variable is the likeliest misconfiguration, and failing open would
publish the dashboard.

```sh
pnpm preflight     # should now be clean, or tell you exactly what is not
pnpm start         # console on :3000
```

## The other processes

Only the console is mandatory. Each of these adds a capability and each fails
in a different way — see [operations](./operations.md).

```sh
pnpm trade -- --interval 300          # Asset Markets loop. EXACTLY ONE INSTANCE
pnpm record                           # market-data recorder
pnpm halt:server                      # kill switch that outlives the console
docker compose --profile events up -d # Event Markets engine
```

## Verify it

```sh
pnpm test:all      # 461 vitest · 73 event-desk checks · 137 pytest
pnpm preflight     # 18 live checks against the real world
```

`/gallery` renders every shared component in every state. It is not in the
navigation — it is a workbench — but it is the fastest way to see whether a
styling change broke something you were not looking at.

## What you should see

A console reporting **PAPER** in the header and mostly empty screens. That is
correct. Both desks only act when the evidence says to, and on a fresh install
there is no evidence yet: no capital, no recorded history, no scored
opportunities. The screens will fill as the recorder captures and the loop runs.

If a screen says **NOTHING IS SCANNING** rather than **NO ARBITRAGE OPEN**, that
is a fault and not a market condition. Start the relevant engine.
