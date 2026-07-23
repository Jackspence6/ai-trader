# Machine Learning Plan — what to build, what it costs, who does what

**Status:** 2026-07-23 · The decision document for expanding ML in Meridian.
**Companions:** `ROADMAP.md` (sequencing) · `DESIGN.md` (principles, esp. #7: models never place orders)

---

## 0. The honest frame first

ML earns its place here the same way a strategy does: **evidence before
power.** We already have the pattern working end to end — the funding
persistence model is trained on free data, walk-forward validated, graded
live on a permanent prediction ledger, and earns/loses its veto power
automatically. Everything below follows that same pipeline:

```
free data → feature → model → walk-forward validation → SHADOW on the feed
        → live grading on the ledger → earns power (veto / sizing) → or demoted
```

What ML **can** do for a system like this: better entry/exit *filters*,
better *sizing*, regime awareness, and learning from its own mistakes.
What it **cannot** do at our data size: predict prices. Anyone selling that
is selling noise. We do not build price predictors, we do not pay for
signal subscriptions, and no model ever generates an order — models filter
and scale what the rule-based scanners propose.

---

## 1. What already exists (the foundation)

| Piece | Status |
|---|---|
| Funding persistence model (5 regime features, logistic) | Live, retrained every pass, SHADOW |
| Walk-forward validation vs baseline | Beats baseline OOS (89.9% vs 87.4% precision) |
| Prediction ledger + self-grading | 40 predictions maturing; first grades ~Jul 30 |
| Evidence-gated promotion (veto power on L1) | Automatic, reversible |
| Decision-quality tracking (bad takes / regretted rejections) | Accruing |

---

## 2. The ladder — ranked by value per unit of cost and effort

### Tier A — free, I build alone, no sign-ups

**A1 · Fear & Greed regime feature** — *highest value/effort ratio.*
[alternative.me](https://alternative.me/crypto/fear-and-greed-index/)
publishes a free, keyless API with **full daily history** (`/fng/?limit=0`).
That means we can backtest it immediately — no waiting to accumulate data.
Hypotheses to test: does extreme greed predict funding persistence (crowded
longs pay shorts)? Does extreme fear predict H1 breakout failure? If
walk-forward says yes, it becomes a sixth feature in the persistence model
and/or an H1 entry filter. **Cost: $0. Effort: ~half a day.**

**A2 · Derivatives-positioning features** — Binance publishes free futures
data endpoints: open interest history, top-trader long/short ratio, taker
buy/sell volume. Only ~30 days of history is served, so step one is simply
**recording them from today** (the recorder already runs 24/7 — every day
not recorded is training data lost forever). In ~6–8 weeks there is enough
to test as persistence-model features. **Cost: $0. Effort: ~half a day to
record, revisit in 6 weeks.**

**A3 · Volatility forecasting for sizing** — an EWMA/GARCH-lite vol
forecast (pure TS, free) to replace trailing realised vol in the trend
gate's position sizing. Better vol estimates → steadier risk per trade.
Validated by comparing forecast error vs trailing vol on history.
**Cost: $0. Effort: ~half a day.**

**A4 · Meta-labeling** *(the classic "second opinion" model)* — a model
that looks at each signal the scanners propose and predicts "will THIS
trade win?", trained on our own completed trades. This is the single most
respected ML technique in systematic trading — but it needs a few hundred
completed trades and we have ~17. **The machinery (ledger) is already
collecting the training data.** Revisit at ~200 trades. **Cost: $0.
Effort: 1 day, months from now.**

### Tier B — free, but needs something from you

**B1 · News sentiment features.** CryptoPanic's free API tier is being
discontinued (April 2026), so the honest free path is:
[CryptoCompare's news API](https://coinmarketcap.com/academy/article/best-free-crypto-api-in-2026-free-tier-comparison)
(free developer key) or keyless aggregators. Headlines get scored by a
small local sentiment model (free, runs on your Mac) and recorded as a
feature — same accumulate-then-validate path as A2.
**You:** create a free CryptoCompare developer account, paste the key into
`.env.local`. Two minutes. **Cost: $0.**

**B2 · Telegram alerts** *(not ML, but the ops layer the ML needs)* — when
the model gets vetoed, promoted, demoted, or the loop stalls, your phone
should know. **You:** message @BotFather on Telegram, create a bot, send me
the token. Two minutes. **Cost: $0.**

### Tier C — cheap paid, when we choose to

**C1 · Claude regime classifier (~$1/month).** A scheduled Haiku call
reading the free inputs (F&G, funding regime, headlines) and returning a
structured regime label that scales risk multipliers — never places orders
(DESIGN.md's planned LLM layer, D7). Goes through the same ledger: its
regime calls get graded against what happened. **You:** an Anthropic API
key when we're ready. **Cost: ~$1/mo at Haiku pricing.**

**C2 · Deeper LLM event analysis (~$5–20/month)** — reading full articles
around large moves, flagging listing/delisting/regulatory events per asset.
Only worth it once C1 proves the regime layer earns.

### Tier D — deliberately NOT doing

- **Price-prediction deep learning** — thousands of parameters vs hundreds
  of samples = memorised noise with a confidence interval.
- **Paid signal services** — unverifiable edges, guaranteed cost.
- **Reinforcement learning on the live book** — needs millions of episodes;
  we get ~288 passes/day.
- **Anything that places orders** — models filter and scale; rules trade.

---

## 3. Recommended sequence

1. **Now:** A1 (F&G — backtestable today) + A2 (start recording) + A3 (vol
   sizing). All free, all mine.
2. **You, when convenient:** B2 Telegram token (2 min), B1 CryptoCompare
   key (2 min).
3. **~6 weeks:** validate A2 features once recorded history exists.
4. **When paper P&L justifies spend:** C1 regime classifier (~$1/mo).
5. **At ~200 completed trades:** A4 meta-labeling — the big one.

Every item ships the same way: validated on history → SHADOW on the feed →
graded on the ledger → earns power or doesn't. Nothing skips the ladder.

---

## 4. What I need from you (all optional, all ~2 minutes each)

| # | What | Where | Unlocks |
|---|---|---|---|
| 1 | Telegram bot token | @BotFather in Telegram | Phone alerts for halts, promotions, stalls |
| 2 | CryptoCompare free API key | cryptocompare.com developer signup | News sentiment features (B1) |
| 3 | Anthropic API key (later) | console.anthropic.com | Regime classifier at ~$1/mo (C1) |

Nothing is blocked today — Tier A needs no accounts at all.
