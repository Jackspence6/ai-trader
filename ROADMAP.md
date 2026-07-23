# Roadmap — from here to a fully autonomous platform

**Status:** 2026-07-22 · ~18,400 lines, 310 tests, 10 commits
**Companions:** `DESIGN.md` (architecture) · `STRATEGY.md` (what we trade and why)

---

## 0. Where we honestly are

**Built: a measurement system.** It reads live markets from three venues, scores every opportunity through a tested cost and risk model, and records what it would do and why. That is genuinely useful — it is the evidence base that decides whether any of this is worth funding.

**Not built: the engine.** Nothing in this repo can place an order, hold a position, or track a balance. There is no order path at all. Everything below the dashboard layer is still to come, and it is the larger half of the work.

The honest one-liner: **we have the instrument panel and the maths. We do not have the aircraft.**

---

## 1. Done

### Calculation core — `src/lib/calc/` (pure, 65 tests)

| Module | What it does |
|---|---|
| `indicators.ts` | EMA/SMA, RSI, ATR, true range, Donchian, z-score, percentile rank, realised vol, log returns, max drawdown, Sharpe, Sortino, correlation. Null-padded warm-up so indexes stay aligned. |
| `costs.ts` | Maker/taker fees per venue, half-spread, square-root market impact, minimum-notional drag. Unknown venue → worst known fees; unknown depth → punitive slippage. |
| `funding.ts` | Carry evaluation (capital efficiency `L/(L+1)`, cost amortisation, breakeven days, liquidation distance), cross-venue funding spread, regime classification on the median. |
| `sizing.ts` | Volatility targeting, risk-unit sizing, fractional Kelly (refuses full Kelly), taper-to-limit, lot quantisation. |
| `tiers.ts` | Capital ladder T0–T5, 7-day promotion hold, immediate demotion. |
| `gate.ts` | 19 pre-trade rejection codes, evaluated cheapest-and-most-absolute first, each returning the values it compared. |

### Sleeves — `src/lib/portfolio/` (34 tests)

Four separately-mandated books (Core / Accumulation / Systematic / Opportunistic) inside one account. Own capital, own strategies, own limits, own halt state. Blast-radius isolation proven by test. Minimum-viable-capital floor per sleeve. Over-allocation scales proportionally rather than failing the save.

### Live market data — `src/lib/market/`

Binance, Bybit and Hyperliquid public endpoints. No credentials, so nothing here *can* trade. Funding annualised per venue's own interval. Independent venue failure. FX rates for display currency.

### Dashboard — 5 live screens

Command · Markets · Signals · Allocation · Control · Treasury. Real data throughout, zeros where there is genuinely nothing, dashes where a venue does not publish a field. Currency switcher (USD/ZAR/EUR/GBP). Config persisted with a field-level audit log.

### Scanner — `src/lib/engine/scanner.ts`

Scores L1 (funding carry) and L2 (cross-venue spread) across the 8-asset universe, routes each to its sleeve, runs the full gate, and reports the binding constraint.

### Capital ledger — two accounts, ZAR-native (`src/lib/fund/`)

Capital is split across a **crypto** book and a **forex** book. Each has its own balance and NAV; a position's P&L is attributed to the account matching its sleeve's asset class, and the two always sum to the fund total because the total is the sum. Deposits can be made in **ZAR** — converted at the live rate the instant they are recorded and stored as canonical USD, with the original rand amount and rate kept for audit. The book starts at zero and is seeded from real recorded events only (`scripts/seed-ledger.ts`), never a hand-set balance. Treasury shows both accounts, per-account P&L, a live-rate badge and a refresh control.

### Resilient currency conversion — `src/lib/market/convert.ts`

A conversion is never "unavailable". Live ECB fix when the provider answers, the last-known fix from a durable cache when it does not, a labelled reference seed only before the first fetch. The old degraded-to-zero path that surfaced "rate n/a" is gone.

### Forex signals — the strategy, not just the mandate (`src/lib/calc/fxsignal.ts`, 11 tests)

The two FX sleeves now have a computed strategy. **F1 · Carry** scores the interest differential in its profitable direction, charged the broker swap markup — the cost that turns most retail carry negative — and only reports "viable" when what survives clears a risk floor. **F2 · Trend** is a dual moving-average read, volatility-measured, that stays flat in a range. Served live at `/api/forex` and surfaced on Allocation.

### Backtest — does the edge survive costs? (`src/lib/backtest/`)

Replays real Binance funding history through the same carry logic (same entry
floor, persistence filter, net-edge gate and exit rule as live) to answer, now
rather than in months, whether funding carry actually makes money. It is
deliberately honest: L1 single-venue only, delta-neutral so price cancels,
modelled round-trip cost charged in full. Surfaced on a rebuilt Research screen
with a verdict, equity curve, per-asset breakdown and explicit caveats.

**The finding is sobering and important.** Over the last ~167 days, the live
config (8% funding floor, 21-day assumed hold) would have **lost ~3.5% on
notional with a 0% win rate across ~85 trades** — a ~35bp retail round-trip cost
against trades that hold ~2 days and collect only a few bp of funding. Richer
funding floors find almost nothing. The honest read: single-venue funding carry
at retail costs churned and lost this period. That argues for cheaper execution
(maker fills / fee tiers), exit hysteresis to stop churning, and leaning on L2
cross-venue spreads (wider edges) rather than L1 — and it is exactly the kind of
thing the system should be able to tell you before risking money.

### Risk-limit enforcement — the limits are real (`src/lib/engine/risk.ts`)

The drawdown and daily-loss limits were displayed but never acted on —
`dailyLossLimitHit` was hard-coded false and no sleeve was ever halted. Now
every pass measures the live book against its limits: a fund breach (drawdown
from high-water, or loss on the day) trips the global halt; a sleeve past its
own drawdown limit is halted on its own, leaving the rest trading — the
blast-radius isolation the design promised. High-water marks are seeded from the
current value so a fresh book can't false-trip, and halts are one-way (recovering
does not un-halt; resuming is a deliberate operator action). Utilisation against
every limit is shown live on the Risk screen. Verified live: a healthy carry
book sits at 0% drawdown and does not trip.

### Position exits — the trading loop closes (`src/lib/oms/exits.ts`)

The scanner opened trades; now they close. Each pass, before new entries, every
open trade is checked against the reason it was put on: a funding carry closes
when funding turns negative, a cross-venue spread when the spread inverts, an FX
carry when the net-of-swap differential goes negative, and any trade on a stop
if it is down past a backstop. Exits are evaluated per **trade**, not per leg —
a carry closes both legs together or neither, so a hedge is never left half-on
as a naked position. Verified live: a spread whose edge disappeared closed both
legs, realised the round-trip, and freed the slot for a fresh opportunity in the
same pass. This is what turns the system from "open and hold forever" into a
managed book whose P&L reflects a real strategy.

### Forex execution — the forex account trades (`src/lib/engine/forexscan.ts`, `src/lib/oms/fxcarry.ts`)

**F1 carry now paper-trades through the same engine as crypto.** FX carry opportunities are scored, gated and executed against a simulated FX venue (single spot leg, per-pair spread modelled and paid), and the interest differential accrues as a `FundingPayment` — the same mechanism crypto funding uses, with the direction and swap cost handled honestly (a decayed carry accrues negative). Positions attribute to the forex account by sleeve asset class, and the tier's concurrent-position budget is now spent **per account** so a crypto trade never starves a forex one. Verified live against Neon: an F1 USD/JPY carry executes into the forex book and accrues carry the next pass. FX carry is held over its own quarter-long horizon, not the crypto funding hold — the carry is a slow, months-long trade.

**F2 trend is still scored, not executed.** The risk gate scores a trade by measurable net edge, which a carry has and a stop-managed trend bet does not — forcing trend through an edge gate would be dishonest bookkeeping. It needs a gate built for how trend-following actually works (invalidation and volatility stops), which is the next piece.

### Carry income actually books — and the book actually fills (2026-07-22)

A full review of the money path found and fixed the reasons paper P&L was
structurally flat:

- **Crypto perp funding never accrued.** FX carry booked its differential;
  a crypto carry's `fundingUsd` stayed zero forever — the core strategy's
  entire income stream was missing from P&L. `oms/perpfunding.ts` now accrues
  perp funding each pass through the same `FundingPayment` mechanism, signed
  correctly in both directions (`accrueCarry` in `engine/pass.ts` books both
  asset classes on one clock).
- **The paper book was starved by the promotion hold.** Paper gated on the
  hold-gated effective tier (T0 → one position per account), so one carry
  blocked every other candidate — including L2 spreads at 30–50bp net —
  for the week the hold needs to mature. Paper now gates at the tier NAV
  implies; live capital still resolves through the hold.
- **Exits churned on single funding prints.** The backtest's core finding was
  that single-print exits produced ~2-day holds that never amortised entry
  costs. A funding-carry exit now requires the regime median to be negative
  too, where history exists (`fundingMedianApr` in `oms/exits.ts`).
- **Tier promotion was gameable by stale history.** `daysHeldAbove` counted
  its streak from the last recorded day (not yesterday) and skipped calendar
  gaps — sparse or stale NAV history could satisfy the 7-day hold. Now
  anchored at yesterday, calendar-consecutive, with regression tests.
- **The FX sleeves were absent from stored config**, so every F1 opportunity
  died on `sleeve_disabled`. fx-carry is allocated and enabled; F1 executes.
- **The live loop and recorder were running stale morning code** (pre-exits,
  pre-OKX: 40 quotes/scan instead of 56). Restarted on current code.
  Operational lesson: the loop must be restarted after deploying engine
  changes — it loads code once at start.

Verified live: an L2 AVAX spread and two F1 carries executed in consecutive
passes, funding accrues on every open position each pass, and predicted vs
realised entry cost error is 0.0bp on both strategies.

---

## 2. Still to do

Ordered by dependency. Nothing later works without the things above it.

### Phase A · The engine — the missing half

Without this the platform cannot trade at all. This is the biggest single block of work.

| # | Item | Why it matters | Est. |
|---|---|---|---|
| ~~A1~~ | ~~**Persistent store**~~ — **DONE.** TimescaleDB in Docker Compose, migration runner with checksums, idempotent JSONL importer, NAV history unfreezing the tier ladder. Optional by design: nothing in the live path blocks on it. | Positions, fills and PnL need real storage, and NAV history is a precondition for tier promotion. | ✅ |
| ~~A2~~ | ~~**Encrypted credential vault**~~ — **DONE.** AES-256-GCM + scrypt, secrets write-only, withdrawal permission hard-blocked with no override. | The gate between "reads public data" and "can act". | ✅ |
| A3 | **Venue adapters, authenticated** — *read-only half DONE* (Binance + Bybit permissions and balances, signing verified against published vectors). Orders, positions and user-data streams remain. | Per-venue quirks: tick/lot size, min notional, post-only rejects, Hyperliquid's volume-based rate budget. | 3d |
| A4 | **OMS / order lifecycle** — *simulated half DONE* (venue interface, pessimistic paper venue, intents → gate → orders → fills, multi-leg with unwind-on-partial). Live venue adapters and venue-truth reconciliation remain. | The exchange is always the source of truth. Our state drifting from theirs is a halt-worthy event. | 3d |
| ~~A5~~ | ~~**Position & PnL accounting**~~ — **DONE.** Positions derived by replaying fills, realised/unrealised/funding/fees, per-sleeve attribution, delta-by-underlying. | Sleeve isolation was theoretical until this existed. | ✅ |
| A6 | **Continuous reconciliation** — computed vs venue-reported balances | Mismatch beyond tolerance halts trading. Without it we can be wrong for days without knowing. | 2d |
| ~~A7~~ | ~~**Kill switch, for real**~~ — **DONE.** Halt state in its own fail-safe file, venue cancel-all, exchange dead-man timers, three independent access paths. Verified halting with the dashboard killed. | The ability to stop must predate the ability to start. | ✅ |
| ~~A8~~ | ~~**Market-data recorder**~~ — **DONE.** Quotes, funding and scan decisions to append-only JSONL, gzipped daily, PID-based liveness. Runs standalone via `pnpm record`. | Every day this is not running is training data we can never recover. Shipped first for exactly that reason. | ✅ |

**Phase A remaining: ~8–10 days** (A1, A2, A5, A7, A8 done; A3 and A4 half done). At the end of it the system can trade — badly, with one strategy, unproven.

### Phase B · Proving the edge

| # | Item | Why it matters | Est. |
|---|---|---|---|
| B1 | **Backtester** — replay with queue position, real L2 slippage, latency, partial fills, funding on schedule, survivorship | A backtester that lies is worse than none; it manufactures confidence. Fill realism must be tunable optimistic→pessimistic. | 5–6d |
| ~~B2~~ | ~~**Paper trading**~~ — **DONE.** Same gate as live, live market data, pessimistic simulated fills. | Mandatory gate before any strategy sees capital. | ✅ |
| ~~B3~~ | ~~**Predicted vs realised edge tracking**~~ — **DONE.** Predicted entry cost vs realised entry cost, like for like, per strategy. | The key diagnostic. Divergence means the cost model is wrong, and everything downstream of it is too. | ✅ |
| B4 | **Parameter sweeps + walk-forward** with sensitivity heatmaps | A strategy that only works at one exact parameter value is overfit. | 3d |

**Phase B remaining: ~8–9 days** (B2, B3 done).

### Phase C · The strategies themselves

Only L1 and L2 exist, and only as scanners — no execution logic, no position management.

| # | Strategy | Sleeve | Est. |
|---|---|---|---|
| C1 | L1 funding carry — full lifecycle: entry, margin top-up, unwind on inversion | Core | 3–4d |
| C2 | L2 cross-venue spread — dual-venue margin management | Core | 3d |
| C3 | L3 stablecoin peg scanner | Core | 1d |
| C4 | B1/B2 spot accumulation + carry overlay | Accumulation | 2–3d |
| C5 | H1 trend following — Donchian/MA breakout, ATR stops, vol sizing | Systematic | 3–4d |
| C6 | H2 statistical pairs — cointegration with a break-exit override | Systematic | 4d |
| C7 | M2 basis / calendar spread | Systematic | 3d |
| C8 | H3 funding-extreme reversal · H4 liquidation-cascade fade | Opportunistic | 4–5d |
| C9 | M1 cross-venue spot spread (pre-funded inventory) | — (T3+) | 4d |
| C10 | M3 passive market making | — (T4+) | 5–6d |

**Phase C total: ~32–40 days** for the full set. The first three (~7d) are what T1–T2 actually needs.

### Phase D · Autonomy

This is what "makes all its own decisions" actually requires.

| # | Item | Why it matters | Est. |
|---|---|---|---|
| D1 | **Scheduler / supervisor** — the always-on loop that scans, decides, executes, monitors without a human present | Currently every decision happens because a browser polled an endpoint. | 3d |
| D2 | **Automatic sleeve halt & resume** on drawdown and daily-loss breach | The isolation promise, actually enforced. Resume needs a cool-down, not an instant retry. | 2d |
| D3 | **Auto-rebalancing between sleeves** — drift bands, cheapest transfer route | Sleeves drift as they earn and lose. | 3d |
| D4 | **Meta-allocator** — shift capital by realised risk-adjusted performance, with hysteresis and a minimum-sample floor | Off until there is enough live history for it to mean anything. | 4d |
| D5 | **Tier promotion tracking** — 7-day NAV history, automatic promote/demote | The ladder is currently frozen at T0 because nothing records NAV over time. | 1d |
| D6 | **Self-healing** — reconnect, restart, resume with open positions, degraded-venue failover | Full recovery from a hard process kill mid-position must be a tested path. | 3d |
| D7 | **LLM regime layer** — classify regime, adjust risk multipliers, never place orders | Deferred. A refinement on a working system, not a foundation. | 3d |

**Phase D total: ~19 days.**

### Phase E · Operations

| # | Item | Est. |
|---|---|---|
| E1 | Telegram alerting — fills, breaches, halts, reconciliation failures, verified on a real phone | 2d |
| E2 | Dashboard auth + Tailscale deployment | 2d |
| E3 | Remaining screens: Positions, Orders/Fills with latency breakdown, Strategies, Risk, Research, System Health | 5–6d |
| E4 | Ledger & tax export (CSV) | 2d |
| E5 | Chaos testing — kill services mid-trade, venue outage, partial fill storms | 3d |
| E6 | Runbooks and disaster recovery | 2d |

**Phase E total: ~16–17 days.**

---

## 3. Totals

| Phase | Scope | Estimate |
|---|---|---|
| A | The engine | 21–25d |
| B | Proving the edge | 12–13d |
| C | Strategies (full set) | 32–40d |
| D | Autonomy | 19d |
| E | Operations | 16–17d |
| | **Total** | **~100–115 focused days** |

**Minimum path to live trading on one strategy, one sleeve:** A1–A8 + B1–B3 + C1 + E1–E2 ≈ **40–45 days**. That is the real number for "it can trade Core with real money, safely, and we can tell whether it's working."

---

## 4. Three things I will not promise

**1. Profitability.** I can build every item above and the system can still not make money. Whether the edge survives contact with real fills is an empirical question, and the shadow data is what answers it. Anyone who tells you a number before that evidence exists is guessing. The realistic target remains 10–25% APR on the Core sleeve, with a real chance of underperforming a simple BTC holding.

**2. Full autonomy without exceptions.** Three decisions should stay human-gated, permanently:

- **Withdrawals.** Our API keys cannot withdraw, by design. Automating this removes the single highest-value security control in the system.
- **Promoting a strategy from shadow to live.** The whole point of the go-live gate is that a human looks at the evidence. Automating it means a bug in the evidence pipeline promotes itself.
- **Adding or changing API credentials.** Self-explanatory.

Everything else — scanning, sizing, entering, exiting, halting, rebalancing, resuming — can and should run unattended. That is 95% autonomy with the 5% that would let a bug compound left deliberately manual.

**3. That the estimates are right.** They assume focused sessions and no unpleasant surprises from venue APIs. Exchange integration in particular routinely takes twice as long as expected — Hyperliquid's volume-based rate limiting alone is the kind of thing that eats two days.

---

## 5. What I would do next

**All five same-day items from the 2026-07-22 review are now DONE, same day:**

1. ~~**Margin-aware sleeve deployment.**~~ **Done.** `capitalConsumedUsd`
   measures spot in full and perp/FX legs at margin — the same basis the entry
   gate prices — and the gate converts sleeve headroom from capital to
   notional. Core went from "exhausted at 2 trades" to honestly holding 3.
2. ~~**F2 trend execution gate.**~~ **Done.** `evaluateTrendGate`: engaged
   signal, honest volatility, a real invalidation distance, size fixed so the
   loss at the stop is 1% of the sleeve. Exits on signal flip or the vol stop;
   a FLAT signal is a range, not a reversal, and does not churn the book.
   Verified live: EURUSD and GBPUSD trend positions entered same pass.
3. ~~**L3 stablecoin peg scanner.**~~ **Done.** USDC/FDUSD priced off Binance
   book tickers as first-class quotes; discount side only (no borrow, no
   fantasy shorts); exits on `peg_restored`. In calm markets its output is
   honest silence.
4. ~~**Maker-entry + exit-rule scenarios.**~~ **Done, with a finding.** The
   backtest now prices the execution-lever grid on real history. Over 90 days:
   taker + single-print exit **−2.61%** (65 trades, 0% wins); taker +
   regime-confirmed exit **+0.04%** (4 trades); maker + regime **+0.21%**.
   The exit hysteresis shipped this morning was worth ~2.7% on notional —
   churn was the whole loss.
5. ~~**Loop supervision.**~~ **Done.** `/api/engine` derives loop health from
   the pass log (staleness vs its own cadence, zero-scored streaks, skip
   reasons); System page leads with LOOP RUNNING / LATE / STOPPED / BLIND.

### First machine learning: the funding-persistence model (2026-07-22, later)

`lib/ml/persistence.ts` — a deliberately small, deterministic, dependency-free
logistic model answering the question the backtest proved decides carry P&L:
*will this funding regime persist over the next week?* Five regime features,
economic label (would the next week of funding have summed positive),
walk-forward validated on ~3,600 pooled samples of real Binance history.

**First result: it beats the baseline out-of-sample.** Precision when ≥70%
confident: **89.9%** vs **87.4%** for the median rule the exits use; accuracy
75.8% vs 75.2%; sensible learned weights (persistence share and median level
positive, regime volatility negative). Validated live on the Research screen
("Funding Persistence Model" panel), and every Binance carry opportunity now
carries its probability in SHADOW — recorded, displayed on Opportunities
(PERSIST column), gating nothing. Promotion bar: keep beating the baseline as
live evidence accrues, then let it confirm entries the way the median rule
confirms exits. DESIGN.md principle 7 holds: the model never places orders.

### L2 cross-venue spread: backtested for the first time, and it fails (2026-07-23)

The strategy the roadmap said to "lean on" had never been backtested, because
a spread needs two funding series and only Binance published history to us.
Bybit and OKX history fetchers (`market/venues.ts`, paginated, free) plus
`backtest/spread.ts` close that gap. One alignment subtlety was doing real
damage: **Binance stamps funding times with millisecond jitter** while the
others are exact, so an exact-timestamp join silently drops half the rows.
Both sides now bucket to the 8h boundary.

**The finding: L2 is not tradeable at retail taker cost.** Over 167 days and
24 venue pairs, every exit band tested loses money — 921 round trips at a 0%
win rate on the naive band. The sweep improves monotonically as the band
widens only because a wider band trades *less*; it is measuring the cost of
churn, not finding a profitable setting.

**Root cause — a structural mispricing, not a tuning problem.** Cross-venue
spreads have no persistence: autocorrelation decays to 0.02 within three days
and to zero within seven. Entries taken at ≥7.3% APR realise a forward mean of
0.47% APR, and holds average 1.15 days. The scanner nonetheless scored L2 over
`expectedHoldDays` (21 days, the *carry* hold), overstating expected income by
~18×: an 11% spread booked ~57bp against ~27bp of real cost and looked like a
30bp edge, when it could only ever earn a few bp before mean-reverting. Every
L2 trade was structurally guaranteed to lose ~24bp — which is exactly what the
live book did, seven times overnight, for ~$14.80 against $1.57 of funding
earned.

**Fix:** `L2_SPREAD_HOLD_DAYS = 2` — each strategy scored over the horizon its
signal actually survives, the same pattern already used for FX carry's 90-day
hold. Verified live: L2 now scores −13.8 to −30.4bp and is rejected, while
staying visible with its reason; L1 is unaffected at +26.3bp. The gate is
honest rather than closed — a spread wide enough to pay for itself in two days
would still trade. Surfaced on Backtests so the finding is reproducible.

This is the second time the same lesson has paid: an edge that only exists
because a hold assumption is generous is not an edge.

**Next up:**

1. **Reconciliation + venue truth (A4/A6)** — the remaining gate between the
   paper book and the first live micro-position.
2. **Maker execution for real** — post-only entry tactic in the OMS with
   fill-or-adjust handling, so the backtest's maker scenario becomes the live
   default where fills allow.
3. **Telegram alerting (E1)** wired to the new loop-health states.

The original sequencing rationale below still stands:

1. ~~**A8 — the market-data recorder.**~~ **Done and running.** Recording quotes, funding and scan decisions.
2. ~~**A1 — Postgres/Timescale.**~~ **Done.** Schema, migrations and an idempotent importer; the tier ladder now reads real NAV history.
3. ~~**A2 + A3 — credentials and authenticated adapters**, read-only first.~~ **Done.** Vault enforces trade-only keys; balances are live once a key is added.
4. ~~**A7 — the real kill switch**, before the first order path exists.~~ **Done.** Three access paths; verified working with the dashboard dead.
5. ~~**A4 + A5 — OMS and accounting.**~~ **Done for paper.** Positions, PnL and per-sleeve attribution all work against a simulated venue. What remains is the live venue adapter and reconciliation against venue truth — the step that finally lets an order reach an exchange, and the one worth pausing on.

Meanwhile the scanner keeps running in shadow and accumulating the evidence that decides whether step 5 is worth taking at all.
