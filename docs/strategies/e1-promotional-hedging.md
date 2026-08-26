# E1 — Promotional hedging

**Standing: READY.** Built and verified. Blocked on real accounts and on
re-verifying each promo's terms. The only positive measured edge on this desk.

## Thesis

A sign-up bonus carries a turnover requirement: bet the bonus `R` times before
it is withdrawable. Every qualifying bet is hedged on the opposite outcome at a
second book, so the result of the match does not matter. Each cycle loses a
small, known amount; the bonus is kept.

## The maths

Back at decimal odds `b`, hedge the complement at `h`:

```
hedge stake       H = S · b / h            equalises the two payouts
guaranteed return   = S · b
outlay              = S + H
loss per unit stake L = 1 + b/h − b        the qualifying loss rate
```

Turning over `T = B · R` at that rate costs `T · L`, so:

```
EV = B − T·L = B · (1 − R·L)
```

positive whenever `L < 1/R`. A 5× rollover survives a 20% loss rate; a real
hedged pair costs 2–8% of turnover. **That headroom is the entire thesis** — an
order of magnitude, where a 1% arbitrage has none.

`L` is expressed as a fraction of the *back stake*; the two-book overround is a
fraction of *total outlay*. They differ by a factor of `(1 + b/h)` and both are
shown, because confusing them makes a 4% overround look like a 4% cost when it
is 7.6%.

## Capital, which is not turnover

The question that follows "what is this worth" is "what do I put up", and they
are very different numbers.

**Turnover is not capital.** A 5× rollover on a R2,000 bonus is R10,000 of bets
but nothing like R10,000 of money: each hedged cycle returns ~98% of its outlay
when it settles and funds the next.

**A deposit match scales down and comes back.** "100% up to R20,000" pays R2,000
of bonus on a R2,000 deposit, and the deposit is withdrawn at the end alongside
the bonus. EV is near-linear in what you put up, which is what makes starting
small a real option rather than a compromise.

**Each book's balance swings even though the pair is flat.** The hedge makes the
*pair* riskless, not either leg. Back at 2.0 and roughly half those bets lose,
draining the promo book while the hedge book fills. A plan funded for one cycle
stalls on the first losing run, so the float at each book is sized from the
actual probability of a run — an exact DP over run length, not a rule of thumb.
Over 40 coin-flip cycles a run of five is 47% likely, which is not what
intuition says.

## Worked example

WSB's 100% match, at a typical 4% two-book overround (`b=1.90`, `h=1.947`,
`L=7.59%`):

| Capital | Deposit | Hedge float | Cycles | Cost | EV | At risk |
|---|---|---|---|---|---|---|
| R1,000 | R550 | R450 | 54 | R209 | **R341** | R209 |
| R2,000 | R1,100 | R900 | 54 | R417 | **R683** | R417 |
| R5,000 | R2,750 | R2,250 | 54 | R1,043 | **R1,707** | R1,043 |
| R20,000 | R11,000 | R9,000 | 54 | R4,172 | **R6,828** | R4,172 |
| R45,000 | R22,500 | R22,500 | 40 | R7,586 | **R12,414** | R7,586 |

Only the hedging cost is ever actually at risk. Below the bonus cap the binding
constraint is how many bets a person will place by hand, not money — which is
why the planner refuses to propose more than 60 cycles.

## Parameters

| | Default | What it controls |
|---|---|---|
| `MIN_BET_ZAR` | 10 | Smallest bet the books accept; a plan below it is not executable |
| `DEFAULT_RUIN_TOLERANCE` | 0.05 | Accepted chance a losing run exhausts a book's float |
| `DEFAULT_MAX_CYCLES` | 60 | Placement ceiling. Unconstrained, the optimiser proposes 1,266 bets of R11 |

## Known limitations

- **It is a one-time harvest per book, not income.** Three promos ≈ R24k at best
  odds, once.
- **Terms are researched, not verified.** Only WSB's deposit match is explicit in
  its own offer name. Assuming a match where there is none overstates a small
  plan several times over.
- **Accounts get limited.** A book whose only traffic is hedged minimum-odds
  bets notices. All three need clearing before that bites.
- **One account per person, household and IP.** Not negotiable, whatever the EV.
