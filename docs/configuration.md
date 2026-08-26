# Configuration

Every variable is documented inline in [`.env.example`](../.env.example) with
what happens when it is **missing** and when it is **wrong** — those fail very
differently and only one of them is obvious.

This page covers what that file cannot: precedence, and the handful of variables
whose wrong value is dangerous rather than merely inconvenient.

## Precedence

```
real environment  >  .env.local  >  .env  >  built-in defaults
```

Every entry point loads the same files in the same order, via `scripts/env.ts`.
That was not always true: Next.js loads `.env.local` automatically and nothing
else did, so the console read the operator's configuration while the trading
loop, the recorder and the kill switch ran on defaults — from the same
directory, on the same box, at the same time. Point `DATABASE_URL` at a remote
Postgres under that arrangement and the console reads it while the loop writes
to localhost; both report healthy and the disagreement surfaces days later as
missing history.

An explicit `DATABASE_URL=… pnpm trade` still wins over the file, because that
is the whole reason someone types it.

## The dangerous ones

**`MERIDIAN_EXECUTION`** and **`ALLOW_MAINNET_TRADING`** — together these are
the difference between simulated and real money. Neither implies the other, and
anything unrecognised means paper. See [paper and live](./paper-and-live.md).

**`DATABASE_URL`** — wrong and both desks write somewhere nobody meant. Preflight
prints the database it actually reached; trust that line, not the file.

**`SITE_PASSWORD`** — missing and the console serves nothing. It fails closed on
purpose: a missing variable is the likeliest misconfiguration, and failing open
would publish the dashboard to whatever network the box is on.

**`SCAN_SLIPPAGE_BPS`** — set too low and the event board shows arbitrage that
closes before you reach the second leg. It is a modelling assumption pretending
to be a setting.

**`NEXT_PUBLIC_DEMO`** — turns on invented opportunities. The board watermarks
itself, but leave it unset for anything real.

**`STATE_DIR` / `RECORDINGS_DIR`** — point these somewhere you do not back up
and every day of capture is evidence that cannot be recovered later.

## Verifying

```sh
pnpm preflight
```

Eighteen checks that try each dependency rather than reading about it, each
naming the consequence of its own failure.
