# Running Meridian 24/7 on one box

Meridian is designed for a single always-on machine rather than a serverless
host, and the reason is structural: a funding carry has to be checked every few
minutes, a prediction-market book has to be held open on a socket, and a
bookmaker has to be polled on a respectful interval. None of those survive a
platform that bills per invocation and caps cron at once a day.

One box runs five things. Only the first is mandatory.

| Process | What it does | Fails how |
|---|---|---|
| **Console** (`pnpm start`) | The screens and the API | You lose the interface; nothing stops trading |
| **Database** (`docker compose up -d`) | Postgres/Timescale, both desks' schemas | You lose history and the capital ladder |
| **Asset loop** (`pnpm trade`) | Scans, scores, opens and manages paper positions | Nothing is traded on that desk |
| **Recorder** (`pnpm record`) | Captures market data to JSONL for backtests | You lose evidence permanently — this one is worth watching |
| **Events engine** (`--profile events`) | Reads books, matches events, detects arbitrage | The board goes dark and says so |

## From nothing to running

```sh
git clone https://github.com/Jackspence6/ai-trader.git meridian && cd meridian
./scripts/bootstrap.sh
```

The script checks the toolchain, installs dependencies, starts the database,
migrates both schemas, builds the console, and prints what is still unset. It is
safe to re-run.

Then set the two secrets it asks for in `.env.local`:

```sh
SITE_PASSWORD=...          # the console refuses to serve without it — it fails closed
DATABASE_URL=postgresql://trader:trader@localhost:5433/meridian
```

## Keeping it up

`deploy/systemd/` holds four units. On a Linux box:

```sh
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now meridian-console meridian-trade meridian-record
sudo systemctl status meridian-\*
```

Edit `WorkingDirectory` and `User` in each unit first — they assume
`/opt/meridian` and a `meridian` user.

The units matter more than they look. `Restart=always` with a backoff is what
turns "the recorder died at 3am" from a week of missing evidence into a gap of
seconds. And `meridian-trade` is deliberately **not** `Restart=always` on
failure alone — a loop that crashes on a bad config and restarts forever is a
loop that hides the bug.

On macOS, the same four as `launchd` plists with `KeepAlive` — or simply
`pnpm start` in a `tmux` session, which is honest for a spare machine that you
can look at.

## The one instance rule

Exactly one trading loop, ever. Two loops double every position and neither
knows about the other.

```sh
pgrep -f "scripts/trade.ts" | wc -l     # must print 1
```

Restart it after any engine change — it loads strategy code once at start.

## What to check the morning after

* `/system` — loop heartbeat, recorder heartbeat, feed health per venue
* `/events/parameters` — the events desk's own wiring checks
* `/risk` — whether anything tripped a breaker overnight
* `docker compose logs --tail=50 timescale`

## Things that will bite

**Fonts at build time.** `next/font/google` fetches Inter and JetBrains Mono
during `pnpm build`. On a box with no outbound internet the build fails with a
font error and nothing else. Build once with connectivity; the result is cached.

**The kill switch outlives the console.** `pnpm halt` and the standalone endpoint
on :3999 both work when the dashboard does not, which is exactly when you need
them. Start `pnpm halt:server` alongside the console.

**Clock drift.** Funding settles on venue time and matches kick off on SAST.
Keep NTP running; a box thirty seconds behind will mis-window both desks.

**Egress from South Africa.** Polymarket is geoblocked from US IPs and the
bookmaker feeds expect a South African address. Run this box on the connection
it is meant to trade from.
