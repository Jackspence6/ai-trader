# What this system should do next — 2026-08-26

Researched against the live landscape, and against
[`OPPORTUNITIES.md`](../../OPPORTUNITIES.md), which is the standing ledger. Its
dated verdicts are not re-argued here without new evidence, per the session
protocol.

## First: the existing verdicts hold up

Independent 2026 guidance on crypto arbitrage lines up with what this system
already concluded on its own data, which is worth stating because the useful
outcome of research is sometimes "carry on".

| Strategy | Meridian's verdict | External 2026 view |
|---|---|---|
| Funding carry (L1) | FUNDED — breakeven at taker, positive at maker | "Best for retail"; high competition compresses it; venue selection matters |
| Cross-venue spread (L2) | SCORED — structurally negative, mean-reverts in ~1 day | "Execution-engineering project"; edge is latency; very high competition |
| Triangular | Built, never funded | "Mostly educational — don't expect it to pay" |
| Dated basis (M2) | SCORED, ranked next | "Predictable but capital-intensive" |
| Statistical arb | Not pursued | "Not recommended for retail without research infrastructure" |

No verdict changes. The ledger is well calibrated.

## The ranked shortlist

### 1. E6 — Polymarket × Kalshi cross-venue prediction arbitrage

**Recommendation: build this next.** It is the only genuinely new opportunity
the merge unlocked, and the reasons are structural rather than hopeful.

*Edge.* Two venues price the same event under different regulatory regimes,
different user bases and different resolution sources, so they disagree more
than two sportsbooks do. Wide gaps appear on thin, slow markets — one documented
example carried a 36¢ spread on a Ballon d'Or market.

*Why us specifically.* Three things line up. **Kalshi is available in South
Africa** — it is not among the 54 restricted jurisdictions, while the UK,
Canada, Australia, France and Singapore all are. Polymarket already works from
here and is close-only in a growing list of *other* jurisdictions. And the
profile of what is left after the bots — "wide, slow gaps on thin venues" —
is exactly the profile this desk's charter is built for: days, not seconds, and
a person places every bet.

*Code reuse: very high.* Kalshi's taker fee is `0.07 × p × (1−p)` — the same
functional form as Polymarket's, differing only in the constant. The fee model
already takes the rate as a parameter, so **pricing a Kalshi book needs no new
maths at all**; there is a test asserting exactly that. The event matcher, the
effective-odds conversion, the depth model, the scoring and the whole board are
reusable. What is missing is one read-only market adapter.

*Capital.* Small, and locked. This is the real cost: profit is illiquid until
resolution. An 8¢ spread resolving in 90 days annualises to ~40%; the same
spread on a year-out market does not. Any scorer must rank by annualised return,
not by spread — an addition to the existing score, not a new engine.

*Risks.* Resolution divergence is the one that is specific to this trade:
Polymarket resolves through UMA's optimistic oracle, Kalshi through regulated
criteria, and ambiguous events occasionally resolve *differently*. That turns a
"riskless" pair into a total loss on both legs. It must be modelled as a
rules-compatibility axis exactly like tennis retirement is on the sportsbook
side, and an unverified pair must never be shown as clean.

*Effort.* One market adapter, one fee constant (already recorded), one
resolution-risk axis, one annualised-return term in the score. Days, not weeks.

*Caveats before funding.* Kalshi requires full KYC with no unverified tier, and
"supported" is doing heavy lifting on some country rows — several listed
countries have since blocked access. Verify with a funded-but-tiny account
before building anything on it.

### 2. E2 continued — the third and fourth sportsbook

**Recommendation: do this in parallel; it is cheap and it is already the stated
next step.**

Two books measured zero arbitrage across 197 markets with a best gap of −1.3%.
Best-of-N tightens quickly, so the honest experiment is more books rather than
better detection. Hollywoodbets and Supabets are the two integrated in neither
direction, and the discovery method that worked twice is written down.

*What is uncertain* is not the information — we will definitely learn whether
four books cross — but the edge. −1.3% is a real gap and two more books may not
close it. That is worth knowing either way, and it is a day of work.

### 3. M2 — dated-futures basis execution

**Recommendation: endorse the ledger's existing ranking. No change.**

Already scored live every pass, deterministic at settlement, structurally safer
than funding carry, and independently described as predictable-but-capital-
intensive. The only reason it sits behind E6 here is that E6 reuses more of the
merged system and needs less capital to test.

## What was considered and rejected

**Triangular and cross-exchange crypto arbitrage.** Already REJECTED in the
ledger; external guidance agrees emphatically. Not revisited.

**In-play sports arbitrage.** Windows are seconds. The charter is manual
placement. These are incompatible and no amount of engineering reconciles them.

**Narrow, fast prediction-market gaps.** 1–3¢ spreads in liquid markets are a
bot fight requiring always-on low-tail infrastructure. We would be the retail
entrant funding the winners — the same argument that rejected MEV.

**Cross-desk signal sharing.** Tempting because the merge makes it possible, and
thin on inspection. The one version with any substance: the funding-persistence
model produces a probabilistic view on a crypto variable, and Kalshi lists crypto
event contracts, so a calibrated model view could be priced against a market
price. Interesting, speculative, and strictly after E6 exists.

## Where money is currently being left on the table

Ranked by confidence, not size.

1. **No capital is deployed anywhere.** Every strategy is paper. This is
   deliberate and correct, and it is also the largest single gap between what
   the system does and what it could earn.
2. **Promotional hedging is built and unstarted.** R683 of expected value on
   R2,000 at typical odds, and it needs accounts rather than code.
3. **Maker fees on L1.** Funding carry is breakeven at taker and positive at
   maker. The fee tier is a volume threshold, not a code change.
4. **The events engine is not running continuously.** The board can only find
   what it is scanning for, and no capture-rate data exists at all — which is
   the measurement that decides whether E2 is viable.

## Sources

- [Prediction market arbitrage in 2026: mechanics, fees, risks](https://tradoxvps.com/prediction-market-arbitrage-in-2026/)
- [The crypto arbitrage playbook: what still pays in 2026](https://docs.ccxt.com/blog/crypto-arbitrage-strategies)
- [Kalshi restricted countries 2026](https://www.coinperps.com/learn/kalshi-restricted-countries)
- [Where are prediction markets legal — availability by country](https://www.finextra.com/blogposting/31345/where-are-prediction-markets-legal-polymarket-kalshi-and-pariflow-availability-by-country)
