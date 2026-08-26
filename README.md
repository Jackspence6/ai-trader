# Meridian — systematic multi-strategy capital

One firm, two desks, one book. Meridian looks for structural mispricings across
venues and takes them only where the evidence says they exist. Some of those
venues price **assets** — perpetual futures, currency pairs. Others price
**events** — match outcomes, prediction-market contracts. The discipline is the
same on both: measure honestly, cost pessimistically, size by evidence, and grade
yourself afterwards.

Everything is real except the money. Live prices, live funding, live odds, real
fills against a pessimistic simulated venue, real P&L attribution. Paper first,
by design — capital unlocks only through the evidence ladder.

```
FIRM            Overview · Performance · Treasury · Risk · System
ASSET MARKETS   Markets · Opportunities · Positions · Strategies ·
                Portfolios · Exchanges · Parameters · Research     (books in USD)
EVENT MARKETS   Board · Books · Strategies · Promotions ·
                Parameters · Research                              (books in ZAR)
```

Both desks use the same words for the same ideas, so learning one teaches you
most of the other. ⌘K opens the command palette, grouped by desk.

## Run it

Deploying to a machine rather than developing on one? Start with
[deploying on an old machine](docs/deploy-old-machine.md) — it assumes nothing
is installed, covers Windows as well as Linux, and has a prebuilt bundle for a
box that cannot afford to compile. Then
[running unattended](docs/always-on.md) makes it pull its own updates from
`main`.

```sh
pnpm dev                          # the console on :3000 (SITE_PASSWORD in .env.local)
docker compose up -d              # Postgres/Timescale — both desks' schemas
pnpm db:migrate                   # create them

pnpm trade -- --interval 300      # Asset Markets loop (one instance only)
pnpm record                       # market-data recorder
docker compose --profile events up -d   # Event Markets engine

pnpm test:all                     # 478 vitest · 73 events checks · 137 pytest
```

Restart the trading loop after any engine change — it loads code once. Kill with
`pgrep -f "scripts/trade.ts" | xargs kill -9` and verify exactly one leaf process
remains.

## Asset Markets — crypto and FX

Four crypto venues and seven FX pairs, scored through a tested cost and risk
model, paper-traded, exits managed, P&L tracked to the cent. Capital sits exactly
where the backtests point:

| Strategy | Verdict | Allocation |
|---|---|---|
| F1 FX carry | Earns (+4.3%/3y, Sharpe 0.62, both components positive) | $3,500 |
| L1 crypto funding carry | Breakeven at taker; positive at maker; stable plateau | $6,000 (core) |
| L3 stablecoin peg | Near-riskless when it fires; silent otherwise | core |
| L2 cross-venue spread | Structurally negative (mean-reverts in ~1 day) | scored, not sized |
| F2 FX trend | Negative in all 12 parameter cells | defunded, scored in shadow |

A small deterministic funding-persistence model annotates carry entries. It is
trained on free history, walk-forward validated, graded live against what funding
actually did, and starts in SHADOW — promoted only when its matured record beats
the baseline, demoted automatically when its edge decays. It never generates a
trade.

## Event Markets — sportsbooks and prediction markets

Cross-venue arbitrage and promotional hedging, in rand. This desk holds no live
capital and the Strategies screen says so in five places rather than implying
otherwise:

| Edge | Standing | What the measurement said |
|---|---|---|
| E1 Promotional hedging | READY | The only positive measured edge. R2,000 of capital clears ~R683 of EV in ~2 weeks |
| E2 Cross-book arbitrage | MEASURING | 197 live markets across two books, zero arbitrage, best gap −1.3% |
| E3 Book vs prediction | NOT MEASURED | Both sides tested, never pointed at each other |
| E4 Prediction internal | SCORED | 440 markets, zero arbitrage, books ~0.1% inside the line. A validated negative |
| E5 Placement | NOT BUILT | Nothing placed yet, so capture rate has no data |

Two books are integrated (Sunbet on Kambi, Betway SA on Betradar) plus Polymarket.
Public odds endpoints only: no login, account, balance or placement call is ever
made, and no bet is ever placed automatically.

## What is honest about the empty states

A blank board and a dead scanner look identical if you only draw an empty table,
and they need opposite responses. So they are drawn differently — "SCANNING · NO
ARBITRAGE OPEN" is a measurement, "NOTHING IS SCANNING" is a fault. Simulated data
exists for demonstrations and is off unless `NEXT_PUBLIC_DEMO=1`, in which case the
board watermarks itself.

## What is free and what will cost money

**Free now:** all market data (Binance/Bybit/OKX/Hyperliquid public APIs,
Frankfurter ECB fixes, Kambi and Betradar public odds, Polymarket CLOB), the ML
(local, dependency-free), Postgres in Docker, the console.

**Planned spend, when the evidence justifies it:** exchange accounts and API keys
(free, needed for live micro-positions), bookmaker accounts (needed for E1),
Telegram alerts (free, needs a bot token), maker-fee tiers or a VPS ($5–12/mo) —
only after live edge is proven.

## Layout

```
src/app            the console — firm screens, /markets…, /events/…
src/lib/events     the Event Markets library (arb math, fees, promos, capital)
src/lib/*          the Asset Markets engine, ML, OMS, portfolio, recorder
services/events-engine   the Python odds engine (ingest, match, detect, alert)
db/migrations      both desks, `events` namespaced into its own schema
scripts/events     cross-language parity harness — TS must match Python exactly
```

## Docs

- `DESIGN.md` — architecture and principles (the honest economics up front)
- `STRATEGY.md` — what we trade and why
- `ROADMAP.md` — done / in flight / next, with dated findings
- `ML.md` — the machine-learning plan
- `GOVERNANCE.md` — the multi-portfolio charter: caps, isolation, promotion
- `EXPANSION.md` — venue and strategy expansion notes
- `services/events-engine/ops/runbook.md` — bookmaker endpoint discovery
- `services/events-engine/backend/oddsengine/venues/*/discovery.md` — per-book capture records
