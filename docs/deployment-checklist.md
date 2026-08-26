# Deployment checklist

For a first bring-up on a machine that will run continuously. Tick in order;
nothing below assumes the step after it.

## Before you start

- [ ] The box is on the connection it is meant to trade from. Polymarket is
      geoblocked from US IPs and the bookmaker feeds expect a South African
      address. Preflight will tell you, but it is cheaper to know first.
- [ ] Node 22+, Docker, Python 3.11+ installed. `docker info` returns something.
- [ ] NTP is running. `timedatectl` on Linux, Settings → Date & Time on macOS.
      A box thirty seconds behind mis-windows both desks and does it silently.

## Install

- [ ] `git clone <repo> meridian && cd meridian`
- [ ] `./scripts/bootstrap.sh` — safe to re-run, does not overwrite `.env.local`
- [ ] Set `SITE_PASSWORD` in `.env.local`
- [ ] `pnpm preflight` — **no FAIL lines.** WARNs are capabilities you are
      choosing to go without; read each one and decide deliberately
- [ ] `pnpm test:all` — 472 vitest, 73 event checks, 137 pytest

## First start

- [ ] `pnpm start` → open `:3000`, unlock
- [ ] Header reads **PAPER**. If it reads anything else, stop and find out why
- [ ] `/system` — the console is up; the loop and recorder are not yet
- [ ] `pnpm record` in its own terminal → `/system` shows the recorder heartbeat
- [ ] `pnpm halt:server` → `curl localhost:3999/status` answers
- [ ] `pnpm trade -- --interval 300` → **verify exactly one instance**:
      `pgrep -f "scripts/trade.ts" | wc -l` prints `1`
- [ ] `/markets` shows live prices. If it shows NO VENUE ANSWERED, the box
      cannot reach the exchanges and nothing will trade

## Prove the stop works, before you need it

- [ ] Press HALT in the header. Header goes red
- [ ] The response names both desks. A desk reporting "could not be reached" is
      still running — that is the point of the per-desk report
- [ ] `pnpm halt:status` agrees
- [ ] Resume with a written reason. It will refuse without one

## Event Markets (optional)

- [ ] `docker compose --profile events up -d`
- [ ] `/events/books` — which books are reporting
- [ ] `/events` — the board says **SCANNING · NO ARBITRAGE OPEN**, not
      **NOTHING IS SCANNING**. The second means the engine is not running

## Leave it up

- [ ] Copy `deploy/systemd/*.service`, edit `WorkingDirectory` and `User`
- [ ] `systemctl enable --now meridian-console meridian-record meridian-halt`
- [ ] Enable `meridian-trade` **last**, and only after the manual run behaved
- [ ] `mkdir -p /var/log/meridian` and confirm the units are writing there
- [ ] Reboot the box once, deliberately, and check everything comes back

## The morning after

- [ ] `/system` — loop and recorder heartbeats, feed health
- [ ] `/risk` — anything tripped overnight
- [ ] `/performance` — the paper book did something
- [ ] Header still says PAPER

## Before any real money

Do not tick these tomorrow.

- [ ] A week of clean paper operation with no unexplained gaps
- [ ] `/research` verdicts unchanged after that week
- [ ] Testnet run first — it teaches signing, rate limits, partial fills and
      reconnection, none of which the simulated venue can
- [ ] Exchange keys are **trade-only, no withdrawal, IP-whitelisted**. The
      dashboard refuses to enable a key with withdrawal permission
- [ ] Read [paper and live](./paper-and-live.md) end to end
- [ ] Start with an amount you would be relaxed about losing entirely
