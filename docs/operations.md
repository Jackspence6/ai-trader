# Operations

## The five processes

| Process | Command | If it dies |
|---|---|---|
| Console | `pnpm start` | You lose the interface. Nothing stops trading |
| Database | `docker compose up -d` | No history, no capital ladder, no event board |
| Asset loop | `pnpm trade -- --interval 300` | Nothing trades on that desk |
| Recorder | `pnpm record` | **Evidence is lost permanently.** Watch this one |
| Events engine | `docker compose --profile events up -d` | The board goes dark and says so |
| Kill switch | `pnpm halt:server` | You lose the path that works when the console does not |

`deploy/systemd/` holds units for the first four. Two decisions in them are
worth understanding rather than copying:

**The recorder restarts on any exit, not just on failure.** Its failure is
silent and unrecoverable — a backtest cannot be run on data nobody captured, and
you find out weeks later.

**The trading loop does the opposite.** Five failures in two minutes and it
stays down and waits for a person. A loop that crashes on a bad config and
restarts forever is a loop that hides the bug.

## The one-instance rule

Exactly one trading loop. Ever. Two loops double every position and neither
knows about the other.

```sh
pgrep -f "scripts/trade.ts" | wc -l    # must print 1
```

Restart it after any engine change — it loads strategy code once at start.

## Stopping

Three paths, in order of how broken things are:

```sh
# 1. The header button. Two clicks, re-arms after four seconds.
# 2. The CLI, when the console is unreachable:
pnpm halt "reason"
# 3. The standalone endpoint, when the process is unreachable:
curl -X POST localhost:3999/halt -d '{"reason":"..."}'
```

All three stop **both desks**. The Asset loop reads the halt state directly; the
Python events engine reads a flag in its own schema, because it cannot see a
Node process's state file. The response tells you per desk whether it was
reached — a desk reporting "could not be reached" is still running.

Resuming requires a written reason. Halting is cheap and reversible; resuming is
the direction that can lose money.

## What the screens mean

| Screen | The question it answers |
|---|---|
| **Overview** | What is the whole firm worth, and is anything wrong |
| **Markets** | What are prices and funding doing right now |
| **Opportunities** | What did the engine consider, and why did it reject most of it |
| **Positions** | What do we hold and what is it worth |
| **Strategies** | Which edges are funded, and on what evidence |
| **Portfolios** | Where the money is allocated, and how each sleeve is doing |
| **Risk** | What limits exist, how close we are, what tripped |
| **Treasury** | Deposits, balances, and the capital ladder |
| **Research** | Would this have made money on real history |
| **System** | Is the machinery running — loop, recorder, feeds |
| **Event ▸ Board** | Live arbitrage across the books |
| **Event ▸ Books** | Which bookmakers are integrated and reporting |
| **Event ▸ Promotions** | Bonus hedging value and the capital to start |

## When something is wrong

**The board is empty.** Read which empty state it is. "NO ARBITRAGE OPEN" is an
efficient market. "NOTHING IS SCANNING" is a dead engine. "NO FEED" is a missing
database. They are drawn differently for exactly this moment.

**A number looks stale.** Every live panel shows its age. `useLive` marks a feed
stale rather than presenting old data as current.

**A venue is red on System.** Check `/events/parameters` or `/markets` for the
error text. A 403 from a bookmaker is usually the WAF, not the network; a 403
from an exchange usually means the box is not where you think it is.

**Nothing works after a restart.** Run `pnpm preflight`. It tries every
dependency and names the consequence of each failure, which is faster than
reading logs.

**Positions look duplicated after a crash.** They should not be — orders are
recorded before they are submitted, and the pass is idempotent per opportunity
id. If you see genuine duplicates, halt and open `/positions`; the fills store
is the source of truth and the ledger reconciles from it.

## Routine checks

Daily, thirty seconds:

- `/system` — loop heartbeat, recorder heartbeat, feed health
- `/risk` — anything tripped overnight
- Header — still says **PAPER**, unless you changed that deliberately

Weekly:

- `/research` — has any strategy's verdict changed
- `OPPORTUNITIES.md` — update the ledger with what shipped and what was learned
