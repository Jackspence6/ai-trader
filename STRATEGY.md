# Trading Strategy — what we trade, and why

**Status:** v1 · 2026-07-20
**Companion to:** `DESIGN.md` (architecture) — this document covers the *decisions*, that one covers the *machinery*.

---

## 0. The one-paragraph answer

We run **delta-neutral funding-rate carry** as the core strategy: buy spot, short the perpetual future in the same size, collect the funding that longs pay shorts. Directional exposure cancels, so we are not betting on price. We add **cross-venue funding spreads** as the second strategy, which captures the difference between venues' funding rates and is frequently wider than either leg alone. Everything else — trend, pairs, market making — is deliberately deferred until capital and evidence justify it. Realistic expectation on the core: **8–20% APR**, with the honest caveat that a well-built version of this may still underperform simply holding BTC.

---

## 1. Why not the obvious strategies

It's worth being explicit about what we rejected, because the rejected ideas are the ones that sound best.

### Triangular arbitrage — built, never funded

Peer-reviewed replays of real order books found that after transaction costs, slippage and book depth, a *whole week* of triangular opportunities across major exchanges netted **$12–18 total**. Where genuine dislocations appear they are closed by co-located systems in under 100 microseconds. Our realistic round trip from a VPS to a matching engine is 1–20 **milliseconds** — two to three orders of magnitude too slow. This is a physics and fee-tier problem, and no amount of good code closes it.

We build the scanner anyway and run it permanently in shadow. Its value is as a live instrument measuring how efficient our venues are. It is gated on shadow evidence that will, in my expectation, never arrive.

### Naive cross-exchange arbitrage — structurally impossible

Buy on A, withdraw, sell on B does not work: blockchain settlement takes minutes to hours, the spread closes in seconds. The only viable form holds inventory on *both* venues simultaneously and trades the spread in place. That splits our capital across venues and only clears the cost hurdle above roughly 0.25% — uncommon on liquid pairs, and concentrated in exactly the illiquid pairs where exit slippage eats the edge. Deferred to T3.

### Directional trading — small allocation, later

Not because it can't work, but because it is the only category where being wrong is expensive *and* the evidence bar is highest. It gets 5% of capital at T3 and not before.

---

## 2. The core: funding-rate carry (L1)

### The mechanism

Perpetual futures have no expiry, so they need a mechanism to stay tethered to spot. That mechanism is **funding**: every interval (8h on Binance and Bybit, 1h on Hyperliquid), if the perp trades above spot, longs pay shorts a fee proportional to the gap. In a bullish market perps trade persistently above spot, so funding is persistently positive, and shorts are persistently paid.

We take the short side of that payment while neutralising the price risk:

```
Long  1 BTC spot          →  gains if BTC rises, loses if it falls
Short 1 BTC perpetual     →  loses if BTC rises, gains if it falls
                             ─────────────────────────────────────
Net price exposure ≈ 0.   Funding payments accrue every interval.
```

We are not predicting anything. We are being paid to warehouse a risk that leveraged perp longs do not want.

### Why this is the right first strategy at our size

| Property | Why it matters for us |
|---|---|
| No latency edge needed | Funding is set on an 8-hour clock. Being 20ms late costs nothing. Every latency-sensitive strategy is unavailable to us (§1). |
| Low turnover | A position held for weeks amortises its entry cost to near zero. This is the only way to win when round-trip costs are ~20bp. |
| Legible, bounded risks | Funding flipping negative, and perp margin management. Both are monitorable; neither is a tail event. |
| Doesn't need much capital | Same-venue, so no transfer risk and no capital split. Viable from T1. |

### The economics, precisely

Two calculations do most of the work here, and both are implemented in `dashboard/src/lib/calc/funding.ts`.

**Capital efficiency.** The naive view is that $1,000 of carry needs $2,000 — $1,000 of spot plus $1,000 to short. It doesn't: the short only needs *margin*. At leverage L, capital is `notional × (1 + 1/L)`, so return on capital is multiplied by `L/(L+1)`:

| Leverage | Capital for $1,000 carry | % of headline APR recovered | Liquidation distance |
|---|---|---|---|
| 1× | $2,000 | 50% | 99.5% |
| 2× | $1,500 | 67% | 49.5% |
| **3×** | **$1,333** | **75%** | **32.8%** |
| 5× | $1,200 | 83% | 19.5% |
| 10× | $1,100 | 91% | 9.5% |

**3× is our default** and the table shows why: going 3→5× buys 8 percentage points of efficiency while cutting the liquidation buffer by 40%. Going 5→10× buys 8 more points and halves the buffer again. The yield gain flattens exactly as the risk accelerates. Anyone tempted to raise this should look at the right-hand column first.

Note that delta-neutrality protects **PnL, not margin**. If BTC rallies 30%, the spot leg is up and the perp leg is down — net flat — but the loss sits in the perp account while the gain sits in the spot account. Margin must be topped up or the position liquidates while being economically fine. This is the single most likely way this strategy actually loses money, and it's why auto-top-up and liquidation-distance alerts are not optional.

**Cost amortisation.** Round-trip cost is paid once; funding accrues continuously. So the *same* opportunity is unattractive held for a day and attractive held for a month:

```
breakeven_days = round_trip_cost_fraction / (funding_APR / 365)
```

At 11% APR and a 20bp round trip, breakeven is ~6.6 days. The gate refuses any position whose breakeven exceeds its expected hold — a position that cannot repay its costs within the time we intend to hold it is a guaranteed loss, however attractive the annualised headline looks.

### Entry rules

An entry requires **all** of:

1. Annualised funding ≥ **8%** (`minFundingApr`) — below this the position isn't worth the margin attention it demands
2. Net edge after all costs ≥ **15bp** (`minNetEdgeBps`)
3. Breakeven days ≤ expected hold (**21 days** default)
4. Funding positive in ≥ **70%** of the recent window (`minPositiveShare`)
5. Passing every generic risk-gate check (§5)

Rule 4 is the one that isn't obvious and matters most. **Entry timing on carry is about persistence, not level.** A single 40% APR print is usually a liquidation artefact that mean-reverts within one interval. A steady 12% for three weeks is a regime. So the regime classifier scores on the **median** of the window, not the latest value, and separately reports how stable the series has been. A spiky series and a steady series with the same mean are completely different trades.

### Exit rules

- Funding decays below the entry floor and stays there
- Funding **inverts** (we start paying) — immediate unwind, this is the primary loss mode
- Liquidation distance on the perp leg breaches its warning band → deleverage first, unwind if it persists
- Balance reconciliation mismatch → halt and investigate; our model of reality is wrong

---

## 3. The second strategy: cross-venue funding spread (L2)

Short the perp where funding is richest, long the perp where it is cheapest. Delta-neutral without needing a spot leg at all — and the *difference* is often wider than either leg individually.

Live example from the scanner as this was written:

```
LINK   Short Hyperliquid ⇄ Long Bybit    spread 23.12% APR    net +89.7bp    breakeven 6.8d
BTC    Short Bybit ⇄ Long Hyperliquid    spread 11.38% APR    net +43.7bp    breakeven 7.0d
```

Those are real numbers from live venue data, scored against a hypothetical $1,000 position, with fees, half-spread and slippage all deducted.

The cost is real too: both legs are perps, so both need margin and both carry liquidation risk in *opposite* directions. Capital is `2 × notional / L` — this is why L2 is gated to T2, where we can hold margin on two venues simultaneously.

**A normalisation trap worth naming.** Hyperliquid funds hourly; Binance and Bybit fund every 8 hours. Comparing raw rates without normalising is a factor-of-eight error that looks exactly like free money. The venue adapters annualise at the edge (`annualiseFunding`) so nothing downstream can make this mistake — and there's a test asserting an hourly venue at 1/8 the rate produces an identical APR.

---

## 4. Indicators — which, and why each one

Every indicator here is a **filter or a sizing input**, never a standalone entry. That distinction is the difference between a system and a collection of superstitions. All are implemented as pure functions in `dashboard/src/lib/calc/indicators.ts` and unit-tested against hand-computed values.

| Indicator | Used for | Why this one |
|---|---|---|
| **Rolling z-score** | Funding extremes, spot spreads, peg deviations, pairs residuals | The most reused primitive in the system. "Is this unusually far from normal?" in units comparable across assets with completely different price scales. A raw funding rate of 0.01% means nothing; +2.4σ against its own 30-day history is a signal. |
| **Percentile rank** | Funding regime | Preferred over z-score where the distribution is visibly non-normal. Funding has fat tails and a hard floor, so "97th percentile of the last 90 days" is more truthful than "+2.1σ". |
| **Median (not mean)** | Funding regime classification | Robust to single-print spikes. This is what stops a liquidation artefact reading as a rich regime. |
| **ATR (Wilder)** | Position sizing, stop placement | Sizing by ATR rather than fixed percentage means every position risks the same *money* regardless of the asset's volatility — which is what makes a hit rate interpretable at all. Uses true range, so overnight gaps are captured; a high-minus-low implementation would badly undersize stops on gapping assets. |
| **Realised volatility** | Vol-target sizing | Annualised at **365** periods, not 252. Crypto doesn't close on weekends; using the equities convention understates crypto vol by ~17% and systematically oversizes every position. |
| **EMA 20 / 50** | Trend filter | Seeded from an SMA of the first n points, not a single value — seeding on one point lets an outlier dominate exactly where the backtest equity curve starts. Used only as a permission filter for directional entries. |
| **Donchian channel** | Breakout entries (H1, later) | **Excludes the current bar.** If the current bar is included, price can never exceed its own channel high and a breakout can never trigger. Backtests that include it look conservative and are simply broken. |
| **RSI (Wilder)** | Veto filter | Used to *block* mean-reversion entries when momentum is still accelerating against them. The classic "RSI < 30 = buy" fails badly in crypto because strong trends park RSI at an extreme for days. |
| **Max drawdown** | Circuit breaker | Peak-to-trough on the equity curve; drives the halt. |
| **Sharpe / Sortino** | Diagnostics only | Reported with a standing caveat: Sharpe on a short sample of a market-neutral carry strategy is flattering and unstable. Carry earns a little very consistently right up until it doesn't — precisely the return shape Sharpe overstates. Sortino is more honest here, since carry's "upside volatility" is just the funding arriving. Neither is a target to optimise. |
| **Correlation** | Portfolio check | Confirms that positions described as diversified actually are. |

**Warm-up handling:** every indicator returns an array the same length as its input, with `null` for the warm-up period. Returning a truncated array instead misaligns every downstream index and is one of the classic sources of lookahead bias.

---

## 5. Risk — the parts that actually keep us solvent

Strategy selection decides the rate of progress. Sizing and risk decide survival. A mediocre signal sized correctly compounds slowly; an excellent signal sized badly is ruined by one bad week, and "eventually" arrives sooner than intuition suggests.

### Sizing

Three models, used in different places (`calc/sizing.ts`):

- **Volatility targeting** — `notional = NAV × targetVol / assetVol`, capped. Makes a multi-asset book coherent: without it, an equal-dollar SOL position carries roughly twice the risk of an equal-dollar BTC position, and the book's real risk profile is an accident rather than a decision. The cap matters because low measured volatility often *precedes* high volatility; an uncapped vol-targeter builds a huge position right before that resolves.
- **Risk-unit sizing** — `notional = (NAV × riskPerTrade) / stopDistance`. Every directional trade loses the same amount when wrong.
- **Fractional Kelly** — as a **cap only**, and the code refuses to return full Kelly. Kelly assumes the edge is known exactly; ours is estimated from a small sample and will be overstated. Full Kelly on an overestimated edge is an overbet, and even a perfectly-estimated full Kelly has a brutal drawdown profile — a 50% drawdown is an ordinary event. We use quarter Kelly: ~90% of the growth rate at a fraction of the drawdown.

Limits **taper** rather than cliff-edge. Hard limits produce a bad failure mode — full size right up to the cap, then a dead stop. A taper degrades risk consumption gracefully and stops the last increment of a limit being spent on a marginal opportunity.

### The minimum-viable-trade filter

This runs at every tier and is the real protection against small-balance value destruction:

```
reject if:  expected_edge × size  <  fees + expected_slippage + min_notional_drag
```

The arithmetic behind it: exchange minimums are typically $5–10 notional and round-trip fees are ~0.2%. On a $10 minimum order, a healthy 0.25% edge is **2.5 cents gross against 2 cents of fees**. That is not a strategy, it's noise — and it's why "just trade smaller" doesn't work below a floor. Fees and minimums do not scale down with your account.

So the honest answer for very small balances isn't "trade badly", it's "trade narrowly and spend the time proving edge". T0 makes real decisions on real data every second — it just records them instead of paying the fee drag to act on them.

### Cost model

Costs are counted **pessimistically and in full** — both legs, both directions (`calc/costs.ts`):

- Maker/taker fees at the venue's real synced tier
- **Half-spread** for takers — a real cost that gets omitted constantly. A "zero fee" venue with a 20bp spread is more expensive than a 5bp-fee venue with a 2bp spread.
- **Square-root market impact**, anchored on observed spread and real book depth, so a thin altcoin book is automatically punished relative to BTC
- **Minimum-notional drag** where we're forced above our intended size

Two deliberate conservatism choices: an unknown venue falls back to the *worst* known fee schedule rather than costing nothing, and unknown book depth is charged a punitive slippage estimate rather than treated as deep. Silence is not evidence of liquidity.

### The gate

Every intent passes through `calc/gate.ts` and gets a typed decision. Checks run cheapest-and-most-absolute first, which matters for diagnosis: if the system is halted we want every rejection to say "global halt", not a misleading downstream "edge too thin" that sends the operator tuning thresholds to fix a problem that isn't there.

Rejections carry a **reason and the values compared**, always. That's what makes the Signals screen work, and it's why "why is the system not trading?" is answerable here when it's impossible from PnL alone.

---

## 6. What we're actually going to do, in order

| Stage | Capital | What runs live | What we're learning |
|---|---|---|---|
| **Now (T0)** | $0 | Nothing. All strategies shadow. | Does predicted edge match what the market actually offered? Accumulating the recording that no dataset can replace. |
| **T1** | $500+ | L1 funding carry, one venue, 1–2 majors, one position | Does the order path work end to end? Does realised edge match predicted? |
| **T2** | $2.5k+ | + L2 cross-venue spread, L3 stablecoin peg, concurrent positions | Does multi-venue margin management hold up under a real move? |
| **T3** | $10k+ | + M1 spot spread, M2 basis, 5% directional | Does anything beyond carry actually earn its risk? |

**Nothing goes live** until it has cleared the go-live gate in `DESIGN.md` §10: profitable in backtest under *pessimistic* fill assumptions, profitable in ≥2 weeks of paper trading, predicted edge matching realised edge within tolerance, kill switch tested mid-position, reconciliation clean for 7 days, and position sizing starting at ~10% of intended.

---

## 7. Honest expectations

- **Target: 10–25% annual** on deployed capital for a well-built version of this.
- **There is a real chance we underperform simply holding BTC.** Market-neutral means neutral to the upside too.
- The reason to build it is to own the platform and the research loop, so that when capital grows the infrastructure to deploy it seriously already exists and has been proven safe.
- Infrastructure cost is a genuine drag at this size: a $60/month VPS is 7.2% APR on $10k before a single trade. This is why we run on free tiers until a strategy has proven it needs otherwise.

**Treat phase 1 as building the factory, not the profit.**

---

## 8. Where this lives in the code

| Concern | File |
|---|---|
| Indicators | `dashboard/src/lib/calc/indicators.ts` |
| Cost model | `dashboard/src/lib/calc/costs.ts` |
| Funding carry + spread + regime | `dashboard/src/lib/calc/funding.ts` |
| Position sizing | `dashboard/src/lib/calc/sizing.ts` |
| Capital ladder | `dashboard/src/lib/calc/tiers.ts` |
| The risk gate | `dashboard/src/lib/calc/gate.ts` |
| Tests (65) | `dashboard/src/lib/calc/calc.test.ts` |
| Venue adapters | `dashboard/src/lib/market/venues.ts` |
| Scanner | `dashboard/src/lib/engine/scanner.ts` |
| Tunable thresholds | `dashboard/src/lib/engine/config.ts` |

All calculation code is pure and side-effect free, so the same functions run in the dashboard, the backtester and (ported) the live engine. If backtest and live can diverge, they will — and you find out with real money.
