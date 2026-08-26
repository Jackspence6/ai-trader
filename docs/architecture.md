# Architecture

## The shape of it

```
                       ┌──────────────────────────────────┐
                       │  CONSOLE  (Next.js, one process) │
                       │  20 screens · both desks         │
                       │  /api/*  read + control          │
                       └───────────────┬──────────────────┘
                                       │ reads
              ┌────────────────────────┴────────────────────────┐
              │              POSTGRES / TIMESCALE               │
              │   public schema  →  Asset Markets               │
              │   events schema  →  Event Markets               │
              └───┬──────────────────────────────────┬──────────┘
                  │ writes                           │ writes
    ┌─────────────┴──────────────┐      ┌────────────┴─────────────────┐
    │  ASSET LOOP   pnpm trade   │      │  EVENTS ENGINE  (Python)     │
    │  scan → score → gate →     │      │  ingest → match → detect →   │
    │  size → submit → manage    │      │  score → alert               │
    └─────────────┬──────────────┘      └────────────┬─────────────────┘
                  │                                  │
    ┌─────────────┴──────────────┐      ┌────────────┴─────────────────┐
    │  VENUE (resolved)          │      │  BOOKS (read-only)           │
    │  SimulatedVenue  default   │      │  Kambi · Betradar ·          │
    │  ExchangeVenue   opt-in ×2 │      │  Polymarket CLOB             │
    └────────────────────────────┘      └──────────────────────────────┘

    ┌────────────────────────────┐      ┌──────────────────────────────┐
    │  RECORDER   pnpm record    │      │  KILL SWITCH  :3999          │
    │  JSONL → hypertables       │      │  separate process, on purpose│
    └────────────────────────────┘      └──────────────────────────────┘
```

## Why these process boundaries

**The console is not in the trading path.** It reads the database and controls
the two engines; it does not decide anything. Losing it costs you the interface,
not the book — which is why it restarts freely and the trading loop does not.

**The recorder writes files first, database second.** Its failure mode is silent
and permanent: a backtest cannot be run on data nobody captured. So it does not
depend on Postgres being up, and its systemd unit restarts on any exit rather
than only on failure.

**The kill switch is its own process on its own port.** It has to work when the
console is the thing that is broken, which is exactly when someone reaches for
it. There are three paths to it — the header button, `pnpm halt`, and :3999 —
and the last two do not need the first to be alive.

**The events engine is Python and stays that way.** It was built in Python and a
rewrite would buy nothing but risk. It talks to the rest of the system through
the database, which is the only contract between the desks.

## One source of truth for each thing

| | Owner | Everyone else |
|---|---|---|
| Market data (crypto, FX) | `lib/market/venues.ts` → `/api/markets` | reads the snapshot |
| Odds (books, prediction) | events engine → `events` schema | console reads it |
| Positions and fills | `lib/oms/store.ts` | `/api/positions`, performance |
| Capital and NAV | `lib/fund/ledger.ts` | everything, via `/api/fund` |
| Halt state | `lib/killswitch` | both desks, both languages |
| Connection string | `lib/db/client.ts` `databaseUrl()` | both desks, one pool |
| Execution mode | `lib/oms/venues/resolve.ts` | engine, preflight, UI badge |

The last three were the merge's real seams. Before they were consolidated there
were two kill switches (halting one desk left the other trading), two connection
pools resolving different environment variables (so the desks could point at
different databases while both reported healthy), and no single answer to "is
this live?" at all.

## Where risk sits

Risk is a hard gate, not a strategy concern (`DESIGN.md` principle 2). Every
intent passes `lib/calc/gate.ts` before it can become an order, and a strategy
cannot bypass it — a strategy bug costs a rejected order, not the account.

The two engines cannot fight over capital because they do not share any. The
Asset desk's capital is the fund ledger in USD; the Event desk holds none and
its charter is that a person places every bet. When the Event desk is funded,
the shared layer is the fund ledger and the shared limit is the charter
drawdown, both of which already exist.

## Reading the code

```
src/app                  the console — firm screens, /markets…, /events/…
src/components           shared UI: ui.tsx primitives, vis.tsx states, shell
src/lib/engine           the Asset Markets pass: scan, score, gate, execute
src/lib/calc             the maths — costs, sizing, indicators, the risk gate
src/lib/oms              orders: the Venue interface, simulated + exchange
src/lib/ml               the funding-persistence model and its live ledger
src/lib/events           the Event Markets library — arb math, fees, promos
src/lib/fund             capital, NAV, the unit ledger
services/events-engine   the Python odds engine
scripts/events           cross-language parity: TS must equal Python exactly
```
