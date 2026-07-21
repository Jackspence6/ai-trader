# ai-trader

An autonomous crypto trading platform — currently a **measurement system**, not a trading one.

It reads live markets from Binance, Bybit and Hyperliquid, scores every opportunity through a tested cost and risk model, records what it would have done and why, and paper-trades those decisions against simulated fills. It cannot place a real-money order, and the gates preventing that are deliberate.

**Read first:**

- [`DESIGN.md`](DESIGN.md) — architecture, and the economics that constrain it
- [`STRATEGY.md`](STRATEGY.md) — what we trade, why, and what we rejected
- [`ROADMAP.md`](ROADMAP.md) — what is built, what remains, honestly scoped

---

## Running it

```bash
pnpm install
pnpm dev                 # dashboard on :3000
```

With no `DATABASE_URL`, state lives in `.data/` as local files and everything works.

### The always-on pieces

These are daemons, not web pages. They run on a machine you control, not on a serverless host.

```bash
pnpm record              # market-data + decision recorder
pnpm record:stats        # what has been captured
pnpm halt:server         # standalone kill switch on :3999
```

### Stopping everything

Three independent paths, because the failure that takes out one rarely takes out all three:

```bash
pnpm halt "reason"                                  # needs only a shell
curl -X POST localhost:3999/halt -d 'reason=why'    # separate process
```

…or the HALT button pinned to the dashboard header.

### Database

Optional locally, required on a serverless host.

```bash
docker compose up -d     # TimescaleDB for market-data history
pnpm db:migrate
pnpm db:import           # replay recordings into hypertables
pnpm db:status
```

Set `DATABASE_URL` and app state moves to Postgres instead of local files. Migrations that need TimescaleDB are skipped automatically where hypertables are unavailable (Neon, most managed Postgres) — those tables are only ever written by the recorder.

---

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | on serverless | Postgres for config, halt state, vault, paper book |
| `VAULT_KEY` | to store credentials | Master key for credential encryption. Generate with `openssl rand -base64 32`. Never written to disk; losing it means re-adding every key. |
| `ALLOW_MAINNET_TRADING` | **no — leave unset** | One of three gates on real-money orders |
| `STATE_DIR` | no | Relocate local state files |
| `RECORDINGS_DIR` | no | Relocate recordings, e.g. to an external disk |

---

## Safety properties

Enforced in code and covered by tests, not merely intended:

- **A key with withdrawal permission is refused**, with no override.
- **Unreadable halt state reads as HALTED.** A false halt costs an opportunity; a false all-clear is unbounded.
- **Real-money trading requires three independent gates to agree** — credential marked mainnet, `ALLOW_MAINNET_TRADING=true`, and explicit confirmation at the call site.
- **Positions are derived by replaying fills**, never cached, so they cannot drift from their own history.
- **The paper venue is pessimistic** — a round trip at an unchanged price is a loss.

```bash
pnpm test
```
