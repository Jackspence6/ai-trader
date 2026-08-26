# E2 — Cross-book arbitrage

**Standing: MEASURING.** Running live and producing evidence. Not funded.

## Thesis

The same match is priced by several bookmakers. Each holds a margin, but they
hold it in different places — one is long the home side, another is short it.
When the disagreement is larger than the sum of the margins, backing every
outcome across books costs less than it returns, and the difference is locked
before the match starts.

## The logic

1. **Ingest.** Each book's public odds endpoint is polled on its own interval
   with jitter. No account, login, balance or placement call is ever made.
2. **Map.** Each book's markets are mapped to canonical types through an exact
   allowlist — see [why that is an allowlist](#why-market-mapping-is-an-allowlist).
3. **Match.** Events are matched across books by normalised team names
   (rapidfuzz, auto-accept ≥0.92, review 0.75–0.92) and kick-off within a window.
4. **Detect.** For each canonical market present at two or more books, take the
   best price per outcome and compute `S = Σ 1/oᵢ`. Arbitrage iff `S < 1`.
5. **Cost.** Apply the slippage allowance, then check the depth each leg can
   actually absorb.
6. **Score.** 0–100 composite; margin, executable size, window duration, venue
   softness, rules risk, account safety.
7. **Present.** A stake plan. A person places every bet.

## Parameters

| Variable | Default | What it controls |
|---|---|---|
| `SCAN_MIN_MARGIN_PCT` | 0.5 | Below this, an opportunity is not shown. Also the floor that keeps stake rounding from dominating the edge |
| `SCAN_MIN_EXECUTABLE_ZAR` | 2000 | Minimum size a leg must absorb to be worth a placement |
| `SCAN_SLIPPAGE_BPS` | 50 | Assumed adverse movement between seeing a price and getting it |
| `SCAN_TOTAL_STAKE_ZAR` | 10000 | Default total the stake plan sizes from |
| `min_interval_s` (per book) | 15–30 | Politeness. Raising it is the correct response to a book pushing back |

Tuning: raising the margin floor shows fewer, better opportunities. Lowering it
below ~0.15% is pointless — the R10 stake step is comparable to the entire edge.

## Why market mapping is an allowlist

This is the part that would silently lose money if it were done the obvious way.

A single Kambi event carries ~110 bet offers. On one PSL fixture, all of these
were the same offer type with the same full-time flag:

```
Total Goals                   lifetime FULL_TIME   occurrence GOALS
Total Corners                 lifetime FULL_TIME   occurrence (null)
Total Goals by Chippa United  lifetime FULL_TIME   occurrence (null)
Total Goals - 1st Half        lifetime (null)      occurrence GOALS
```

Mapping on the offer type collapses corners, team totals and half totals onto
the match total — at the same line, so they look like the same market and
produce arbitrage that does not exist. Requiring `FULL_TIME` still lets corners
and team totals through, *and* wrongly rejects the genuine full-match "Both
Teams To Score", which carries a null lifetime.

Betway is the same problem in different clothes: its 1st-half total has the same
market type code **and** the same display name as the match total, and only the
provider's group tag separates them.

So a market is mapped only when its exact signature is on an allowlist and the
outcome shape matches what was recorded. Everything else is kept visible and
never priced. Adding a market means observing it first and adding a row.

## Stake naturalisation

Exact stakes are a fingerprint. A desk placing R3,417.62 eight times a day is
announcing itself, and account limitation is the main way this strategy dies.

Rounding to R10 moves each stake by up to R5. On a thin book that can cost more
than the edge is worth — a property sweep found a book the detector correctly
called profitable whose naively-rounded version lost R8.

`naturalizeStakes` rounds, checks the worst branch, and if rounding broke it
bumps the losing leg by one step and re-checks (up to three times), then tries
R50 steps, then returns exact stakes flagged as un-natural. It never returns a
losing plan; when it cannot find a round-number one, the panel says so.

## Known limitations

- **Two books are not enough.** Measured 2026-08-25: 38 shared events, 197
  markets, zero arbitrage, tightest gap −1.3%. Best-of-N tightens quickly, so
  the direct attack is more books, not better detection.
- **Settlement rules are not universally verifiable.** An unverified rules
  profile is never "clean", only unproven. Tennis retirement rules live in
  operator T&Cs, not in any odds payload.
- **Capture rate is unmeasured.** Nothing has been placed. The specification's
  own benchmark is that below 30% manual capture, this is a research project and
  promotional hedging is the primary edge.

## Where the money might still be

- **More books.** Hollywoodbets and Supabets are integrated in neither direction.
- **In-play.** Deliberately out of scope — windows are seconds and the charter
  is manual placement.
- **Lower-liquidity leagues.** The current sweep is top-flight heavy; smaller
  leagues carry wider margins but thinner limits, and limits are what bind here.
