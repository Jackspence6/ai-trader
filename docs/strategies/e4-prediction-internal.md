# E4 — Prediction-market internal arbitrage

**Standing: SCORED.** Measured, working, and empirically empty. A validated
negative rather than a gap.

## Thesis

On a prediction market, a binary question has YES and NO shares that must sum to
$1 at resolution. A complete set of mutually exclusive outcomes must also sum to
$1. If the whole set can be bought for less, the difference is riskless.

## Why it does not pay

Measured 2026-08-25: 440 markets across 29 events, zero parse errors, zero
arbitrage. A direct probe of the tightest books:

| Market | YES+NO raw | with 5% taker fee |
|---|---|---|
| Bellingham Ballon d'Or | 1.0010 | 1.0011 |
| Haaland Ballon d'Or | 1.0010 | 1.0012 |
| Tush Push banned | 1.0010 | 1.0016 |

The book is ~0.1% **inside** the arbitrage line before the fee is applied at
all. The specification's warning that "fees frequently kill thin internal arbs"
is understated: the raw spread alone forecloses it.

## The fee model, which is the whole story

```
fee   = feeRate × p × (1 − p)      rounded to 5dp, floor 0.00001
p_eff = p + fee
o_eff = 1 / p_eff
```

Rates by category: sports 0.05, crypto 0.07, politics/finance 0.04,
geopolitics 0. Read live from the venue per market, never from the docs table —
a stale fee constant is an invented edge.

The shape matters. The fee is largest at `p = 0.5`, which is exactly where thin
arbitrage lives, so a fee-blind detector is wrong precisely where it would cost
the most. The worked example: 0.48 + 0.50 looks like a 2% edge and costs 1.005.

## Also covered

**negRisk complete sets.** Multi-outcome events where a full set must pay $1.
The detector refuses to price a set unless every outcome is quoted — a partial
set looks like a cheap complete one and is not.

**Nested brackets.** "BTC above 200k before 2027" implies "before 2028". Buying
NO on the inner and YES on the outer has a floor of 1 and an upside of 2. The
pairing logic is deliberately strict about what it refuses; 14 of its tests are
about non-pairs.

## Why it stays running

It costs nothing. Spreads move, new categories launch with wider books, and the
scanner is already written and correct. What it must not do is consume attention
that belongs to the edges that measured positive.
