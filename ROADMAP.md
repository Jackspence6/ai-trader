# Roadmap — from here to a fully autonomous platform

**Status:** 2026-07-21 · ~13,600 lines, 161 tests, 7 commits
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
| A4 | **OMS / order lifecycle** — submit, amend, cancel, reconcile against venue truth | The exchange is always the source of truth. Our state drifting from theirs is a halt-worthy event. | 4–5d |
| A5 | **Position & PnL accounting** — realised/unrealised, fee and funding ledger, per-sleeve and per-strategy attribution | Sleeve isolation is currently theoretical: the limits exist, but nothing measures a sleeve's drawdown to trip them. | 3–4d |
| A6 | **Continuous reconciliation** — computed vs venue-reported balances | Mismatch beyond tolerance halts trading. Without it we can be wrong for days without knowing. | 2d |
| A7 | **Kill switch, for real** — cancel-all across venues, optional flatten, plus exchange-side dead-man timers | Today the HALT button flips a config flag. It must cancel resting orders venue-side and register auto-cancel-on-disconnect. | 2d |
| ~~A8~~ | ~~**Market-data recorder**~~ — **DONE.** Quotes, funding and scan decisions to append-only JSONL, gzipped daily, PID-based liveness. Runs standalone via `pnpm record`. | Every day this is not running is training data we can never recover. Shipped first for exactly that reason. | ✅ |

**Phase A remaining: ~13–16 days** (A1, A2, A8 done; A3 half done). At the end of it the system can trade — badly, with one strategy, unproven.

### Phase B · Proving the edge

| # | Item | Why it matters | Est. |
|---|---|---|---|
| B1 | **Backtester** — replay with queue position, real L2 slippage, latency, partial fills, funding on schedule, survivorship | A backtester that lies is worse than none; it manufactures confidence. Fill realism must be tunable optimistic→pessimistic. | 5–6d |
| B2 | **Paper trading** — identical code, live data, simulated fills | Mandatory gate before any strategy sees capital. | 2d |
| B3 | **Predicted vs realised edge tracking** | The key diagnostic. Divergence means the cost model is wrong, and everything downstream of it is too. | 2d |
| B4 | **Parameter sweeps + walk-forward** with sensitivity heatmaps | A strategy that only works at one exact parameter value is overfit. | 3d |

**Phase B total: ~12–13 days.**

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

In order, and the first item is not optional:

1. ~~**A8 — the market-data recorder.**~~ **Done and running.** Recording quotes, funding and scan decisions.
2. ~~**A1 — Postgres/Timescale.**~~ **Done.** Schema, migrations and an idempotent importer; the tier ladder now reads real NAV history.
3. ~~**A2 + A3 — credentials and authenticated adapters**, read-only first.~~ **Done.** Vault enforces trade-only keys; balances are live once a key is added.
4. **A7 — the real kill switch**, before the first order path exists. The ability to stop must predate the ability to start.
5. **A4 + A5 — OMS and accounting.** Then, and only then, C1.

Meanwhile the scanner keeps running in shadow and accumulating the evidence that decides whether step 5 is worth taking at all.
