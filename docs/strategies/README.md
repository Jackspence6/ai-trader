# Strategies

Every edge on both desks, with its standing and the evidence that set it.

The standings mean exactly what they say. `FUNDED` is real money allowed.
`SCORED` means it is priced and watched and deliberately not funded. `NOT
MEASURED` and `NOT BUILT` exist because a strategy card with no numbers reads as
"nothing happening lately" when it should read "nobody has ever run this".

## Asset Markets — crypto and FX

| | Strategy | Standing | Evidence |
|---|---|---|---|
| L1 | [Funding carry](./l1-funding-carry.md) | FUNDED | Breakeven at taker, positive at maker, stable parameter plateau |
| L3 | Stablecoin peg | FUNDED | Near-riskless when it fires, silent otherwise |
| F1 | [FX carry](./f1-fx-carry.md) | FUNDED | +4.3% / 3y, Sharpe 0.62, both components positive |
| L2 | Cross-venue funding spread | SCORED | Structurally negative — the spread mean-reverts in ~1 day |
| F2 | FX trend | SHADOW | Negative in all 12 parameter cells |
| M2 | Dated-futures basis | SCORED | Scored live every pass; execution not built |

Full mechanics, entry and exit rules, sizing and the cost model are in
[`STRATEGY.md`](../../STRATEGY.md), which predates this folder and remains the
authority for the Asset desk.

## Event Markets — sportsbooks and prediction markets

| | Strategy | Standing | Evidence |
|---|---|---|---|
| E1 | [Promotional hedging](./e1-promotional-hedging.md) | READY | The only positive measured edge |
| E2 | [Cross-book arbitrage](./e2-cross-book-arbitrage.md) | MEASURING | 197 live markets, two books, zero arbitrage, best gap −1.3% |
| E3 | Book vs prediction market | NOT MEASURED | Both sides tested, never pointed at each other |
| E4 | [Prediction-market internal](./e4-prediction-internal.md) | SCORED | 440 markets, zero arbitrage, books ~0.1% inside the line |
| E5 | Placement and settlement | NOT BUILT | Nothing placed, so capture rate has no data |

## The shared maths

Both arbitrage strategies use the same identities, verified by property tests in
`src/lib/events/arb.test.ts` and held bit-for-bit against the Python engine by
`scripts/events/check-arb-parity.mjs`.

For a book of decimal odds `o₁…oₙ`:

```
qᵢ = 1 / oᵢ                 implied probability of leg i
S  = Σ qᵢ                    the book sum, or "overround + 1"
margin = 1 − S               positive means arbitrage exists
sᵢ = T · qᵢ / S              stake on leg i for a total stake T
profit = T · (1/S − 1)       identical whichever leg wins
```

Two consequences worth internalising:

**Profit is `T·(1/S − 1)`, not `T·margin`.** They differ by a factor of `1/S`,
which is small but real. The specification prints the approximation in one
worked example; the engine uses the exact form and the test asserts both so the
discrepancy is documented rather than discovered.

**Stakes must be naturalised, and naturalising can break the arb.** Placing
R3,417.62 is a fingerprint. Rounding to R10 moves each stake by up to R5, which
on a thin book can cost more than the edge — see
[E2](./e2-cross-book-arbitrage.md#stake-naturalisation).
