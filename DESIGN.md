# ai-trader — System Design & Build Plan

**Status:** Draft v1 · 2026-07-20
**Config:** Non-US jurisdiction · Starting capital <$10k · CEX + Hyperliquid (no DEX/MEV in phase 1)

---

## 0. Read this section first

Before the architecture, the economics. Three of the strategies you named do not work at this capital level, and the plan is dishonest if it pretends otherwise.

**Triangular arbitrage on a single venue is dead for us.** Peer-reviewed work replaying real order books found that after transaction costs, slippage, and book depth, a *whole week* of opportunities across major exchanges netted **$12–18 total**. Where genuine dislocations appear, they are closed by co-located systems at sub-100µs; our realistic VPS-to-matching-engine round trip is 1–20ms. We are 2–3 orders of magnitude too slow, and no amount of good code closes that gap — it's a physics and fee-tier problem.

We will still **build** the triangular scanner, but it runs in **shadow mode**: it logs every opportunity it would have taken and what it would have earned net of fees. It only becomes eligible for live capital if shadow data proves a positive net edge over a meaningful sample. My expectation is that it never turns on. Its real value is as a live instrument for measuring how efficient our venues are.

**Cross-exchange arbitrage works only with pre-funded inventory.** The naive version — buy on A, withdraw, sell on B — is structurally impossible. Blockchain settlement takes minutes to hours; the spread closes in seconds. The only viable form is holding inventory on *both* venues simultaneously and trading the spread in place, letting balances drift and rebalancing on a slow, separate schedule. That means our capital is divided across venues, so a $10k account is really ~$3k of working capital per venue, and per-venue minimums plus 0.1% round-trip fees mean only spreads above roughly 0.25% are worth touching. Those are uncommon on liquid pairs and concentrated in exactly the illiquid pairs where our exit slippage eats the edge.

**Infrastructure cost is a serious drag at this size.** A Tokyo VPS at $60/month is $720/year — **7.2% APR on $10k before we place a single trade**. Paid market data (Tardis is $599/mo) is completely off the table; it would need a 70%+ return just to break even. This one constraint drives several decisions below: we self-record market data, we run lean infra, and we do not start on expensive hosting until a strategy has proven itself on paper.

**What actually works at this size** is funding-rate carry: delta-neutral spot-long/perp-short positions harvesting the funding payment. It's low-turnover so fees barely matter, it needs no latency edge, and it targets a realistic **8–20% APR** in normal conditions. It's boring, and it is the honest core of this system.

**So the realistic expectation:** a well-built version of this targets roughly **10–25% annual return** on deployed capital, with a real chance of underperforming simply holding BTC. The reason to build it is to own the platform and the research loop — so that when capital grows, the infrastructure to deploy it seriously already exists and has been proven safe. Treat phase 1 as building the factory, not the profit.

Everything below is designed so that being wrong is cheap and recoverable.

---

## 1. Design principles

These are the non-negotiables that everything else derives from.

1. **One strategy codebase across backtest, paper, and live.** A strategy is a pure function of market events to intents. The only thing that changes between modes is which venue implementation sits behind the interface. If backtest and live can diverge, they will, and you'll find out with real money.
2. **Risk is a hard gate, not a strategy concern.** Every order passes through a risk service that can veto it. Strategies cannot bypass it. A strategy bug should cost a rejected order, not the account.
3. **API keys are trade-only, no withdrawal, IP-whitelisted.** This is the single highest-value security control in the system. Enforced and continuously verified in code — the dashboard refuses to enable a key that has withdrawal permission.
4. **Every decision is observable.** Every opportunity the scanner sees is logged with its expected edge, costs, and whether it was taken *and why not*. Debugging a trading system from PnL alone is impossible.
5. **The kill switch must work when everything else is broken.** Separate process, separate endpoint, plus exchange-side dead-man's timers.
6. **Shadow mode before paper, paper before live, live small before live real.** No strategy skips a rung.
7. **The LLM never places orders.** It classifies regime and sets risk multipliers. Non-determinism belongs nowhere near order generation.

---

## 2. Technology choices

| Layer | Choice | Why |
|---|---|---|
| Engine | **Python 3.12 + asyncio** | Our viable strategies operate on second-to-minute timescales. Rust buys microseconds we cannot monetize and costs iteration speed we badly need. Revisit only if we ever do real market making at scale. |
| Exchange connectivity | **CCXT / CCXT Pro** | Unified REST + WebSocket across 74 venues, free. Native SDK for Hyperliquid (better coverage of its specifics) and Binance user-data streams. |
| API | **FastAPI** | Shares Pydantic models with the engine, so strategy params and dashboard forms derive from one schema definition. |
| Dashboard | **Next.js 15 + TypeScript + Tailwind + shadcn/ui** | Dense, fast, good component primitives. |
| Charts | **lightweight-charts** (price) + **Recharts** (analytics) | TradingView's library for candles is unmatched and free. |
| Hot state / bus | **Redis** (Streams + pub/sub) | Inter-service events and live state. One dependency, not a Kafka cluster. |
| Storage | **Postgres + TimescaleDB** | Hypertables for ticks/candles, plain relational for orders/positions/ledger. ClickHouse is faster but a second system to run; at our data volume Timescale is comfortably sufficient. |
| Backtest analytics | **DuckDB + Parquet** | Query recorded Parquet directly for research without loading the production DB. |
| Deploy | **Docker Compose** on a single VPS | Kubernetes at this scale is self-harm. |
| Secrets | **libsodium sealed boxes**, master key in env/OS keychain | Keys never sit in the DB in plaintext, never leave the engine process, never render back to the UI. |

### Infrastructure — target $0.00/month

Every component below is free at our scale, permanently. Not a trial, not a credit that expires.

| Need | Solution | Cost |
|---|---|---|
| Compute | **Oracle Cloud Always Free** — ARM Ampere A1, 2 OCPU / 12GB RAM, 200GB storage | $0 forever |
| Database | TimescaleDB + Postgres in Docker on that box | $0 |
| Redis | Docker on that box | $0 |
| Market data (live) | Exchange WebSockets — free, unlimited | $0 |
| Market data (historical) | data.binance.vision, Kraken CSVs, our own recordings | $0 |
| Remote access for 3 operators | **Tailscale** free tier (100 devices) | $0 |
| Alerting | Telegram bot | $0 |
| Metrics/dashboards | Grafana + Prometheus, self-hosted | $0 |
| Source control / CI | GitHub free | $0 |

Oracle halved the free ARM allocation in June 2026 (was 4 OCPU/24GB), but 2 OCPU/12GB is still comfortably more than this workload needs. The AMD micro instances and 200GB storage are unchanged, so a second box for redundancy is also free.

**Tailscale instead of a public domain** is both cheaper and materially safer: the dashboard is never exposed to the public internet, there's no TLS cert to manage, no login page for anyone to brute-force, and each of the three operators gets device-level access control. A trading dashboard with API keys behind it should not have a public URL.

**Only ever consider paying for** a Tokyo VPS (~$5–12/mo on Hetzner/Vultr, co-located with Binance/Bybit/OKX matching engines), and only once a latency-sensitive strategy has *proven on paper* that it needs it. Nothing in phase 1 does.

---

## 3. Architecture

```
                            ┌──────────────────────────────┐
                            │   Dashboard (Next.js)        │
                            │   REST + WebSocket           │
                            └──────────────┬───────────────┘
                                           │
                            ┌──────────────▼───────────────┐
                            │   API (FastAPI)              │
                            │   auth · config · queries    │
                            └──────────────┬───────────────┘
                                           │  Redis pub/sub
   ┌───────────────┬───────────────┬───────┴───────┬──────────────────┐
   │               │               │               │                  │
┌──▼──────────┐ ┌──▼──────────┐ ┌──▼──────────┐ ┌──▼───────────┐ ┌────▼────────┐
│ md-gateway  │ │  strategy   │ │    risk     │ │  execution   │ │  portfolio  │
│             │ │   engine    │ │   engine    │ │    (OMS)     │ │ accounting  │
│ CCXT Pro WS │ │             │ │             │ │              │ │             │
│ normalize   │→│ strategies  │→│ pre-trade   │→│ order router │→│ positions   │
│ record      │ │ emit intent │ │ hard veto   │ │ venue adapt. │ │ PnL/ledger  │
└──────┬──────┘ └─────────────┘ └──────┬──────┘ └──────┬───────┘ └────┬────────┘
       │                               │               │              │
       │                        ┌──────▼───────┐       │              │
       │                        │ KILL SWITCH  │       │              │
       │                        │ (own process)│       │              │
       │                        └──────────────┘       │              │
       ▼                                               ▼              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  TimescaleDB — ticks · books · candles · orders · fills · positions · ledger │
└────────────────────────────────────────────────────────────────────────────┘
```

### Service responsibilities

**md-gateway** — Maintains WebSocket connections to every enabled venue via CCXT Pro. Normalizes to internal event types (`BookDelta`, `Trade`, `Ticker`, `Funding`). Publishes to Redis for live consumers and writes to Timescale for research. **Records from day one** — our own recorded L2 is more valuable than any purchasable dataset because it's exactly what our strategies saw, including our own latency and gaps. Detects staleness and emits a `VenueDegraded` event that the risk engine acts on.

**strategy-engine** — Hosts strategy plugins. Each implements a narrow interface (`on_book`, `on_trade`, `on_funding`, `on_timer`) and emits `OrderIntent` objects. Strategies are sandboxed: one raising an exception is disabled, not allowed to take down the engine. Each declares a Pydantic params model, which the dashboard renders into a form automatically — no hand-written config UI per strategy.

**risk-engine** — The gate. Every intent is checked against limits before becoming an order (detail in §6). Also runs continuous portfolio-level monitors that can halt trading independently of any strategy.

**execution (OMS)** — Owns order lifecycle. Handles venue quirks (tick size, lot size, min notional, post-only rejections, rate limits). Implements placement tactics: passive-join, aggressive-cross, iceberg, TWAP. Reconciles our order state against the exchange's on a timer — the exchange is always the source of truth.

**portfolio-accounting** — Positions, realized/unrealized PnL, fee and funding ledger, per-strategy attribution. Reconciles computed balances against exchange balances continuously; a mismatch beyond tolerance is a halt-worthy alert, because it means our model of reality is wrong.

**kill-switch** — Deliberately separate, minimal dependencies. Cancels all open orders across all venues, optionally flattens positions, sets the global halt flag. Reachable from dashboard, a CLI, and a plain HTTP endpoint.

---

## 4. Data

### Live
- **Order books, trades, tickers** — CCXT Pro WebSockets. L2 depth at the granularity each venue offers.
- **Funding rates** — REST polling. They update on 1h/8h cadence; WebSocket is unnecessary.
- **Account/fills** — venue user-data streams where available (Binance, Bybit, OKX), REST polling as fallback and reconciliation.
- **Hyperliquid** — native SDK. Note its rate limiting is unusual: a shared 1,200 weight-units/minute budget, plus a long-term allowance of 1 request per 1 USDC of lifetime volume, starting with a 10,000-request buffer. At our volume that buffer matters and the OMS must budget against it explicitly. WebSocket cap is 1,000 subscriptions per IP with no batch subscribe.

### Historical (for backtesting)
- **data.binance.vision** — free bulk klines, aggTrades, and book tickers. The backbone of our historical set.
- **Kraken CSV dumps** — free full trade history per pair.
- **Our own recordings** — the highest-fidelity source, accumulating from day one.
- **Explicitly not buying** Tardis/Kaiko. At $10k capital a $599/mo feed is indefensible.

### Storage layout
Timescale hypertables partitioned by day, with continuous aggregates for common candle intervals. Raw L2 is archived to Parquet after 30 days and queried via DuckDB for research. Compression on; expect 10–15x.

---

## 5. Strategies, by risk tier

Each strategy declares its tier, and capital is allocated per tier with configurable budgets (default **Low 65% / Medium 30% / High 5%**).

### Low risk — market-neutral, the core

**L1 · Funding-rate carry** *(build first)*
Long spot, short perp, same venue, same size. Delta-neutral, so directional moves cancel. Harvests funding paid by longs to shorts. Same-venue means no transfer risk. Entry when annualized funding exceeds a threshold after fees; exit when it decays or inverts. Realistic **8–20% APR**, higher in strong bull funding regimes. Primary risks: funding flipping negative, perp liquidation if margin is mismanaged (we run low leverage and auto-top-up), and exchange counterparty risk.

**L2 · Cross-venue funding spread**
Short the perp where funding is most positive, long the perp where it's least. Delta-neutral without needing spot. Captures the *difference*, which is often wider than either leg. Requires margin on both venues.

**L3 · Stablecoin peg arbitrage**
USDT/USDC/DAI deviations from parity. Rare and small, but genuinely near-riskless when it appears. Cheap to run as a background scanner.

### Medium risk

**M1 · Cross-venue spot spread (pre-funded inventory)**
Hold inventory on multiple venues; when the spread exceeds fees plus a margin, sell the rich side and buy the cheap side simultaneously. No withdrawal in the hot path. Balances drift and are rebalanced on a slow schedule when transfer costs are favorable. This is the *only* honest form of cross-exchange arb.

**M2 · Basis / calendar spread**
Perp versus dated futures, or near versus far expiry. Converges deterministically at expiry.

**M3 · Passive market making**
Quote both sides on one liquid pair, earn the spread and maker rebates, skew quotes by inventory to stay near flat (simplified Avellaneda–Stoikov). Only viable where maker fees are zero or negative. Genuinely risky in trends — inventory accumulates on the losing side — so it ships with hard inventory caps and a trend filter that widens or pulls quotes.

**M4 · Triangular arbitrage — shadow mode only**
Built, instrumented, permanently gated on shadow-mode evidence. See §0. Its purpose is measurement.

### High risk — small allocation, strict stops

**H1 · Trend / momentum** — Donchian or MA breakout on perps, volatility-position-sized, ATR stops. The only strategy that profits from big directional moves.
**H2 · Statistical pairs** — cointegrated alt pairs, z-score entry/exit, with a cointegration-break exit that overrides the z-score.
**H3 · Funding-extreme reversal** — fade positioning when funding hits historical extremes, signalling a crowded book.
**H4 · Liquidation-cascade fade** — provide liquidity into forced-liquidation wicks with tight invalidation.

### The LLM layer (optional, later)

A regime classifier, **not** a trader. Periodically ingests funding/volatility/breadth data and a news feed, and outputs a structured regime label with confidence. That label adjusts risk multipliers and can disable strategies unsuited to the regime. It never emits an order, never sizes a position, and its output is always bounded by the same risk limits. Non-determinism has no place in order generation — it goes in the slow, supervisory loop.

### Meta-allocator

Shifts capital between strategies based on realized risk-adjusted performance, with hysteresis and a minimum-sample floor so it doesn't chase noise. Off by default until we have enough live history for it to mean anything.

---

## 6. Risk management

### Pre-trade (every order, no exceptions)
Max order notional · max position per symbol · max gross and net exposure · leverage cap per venue · price sanity band versus mid · fat-finger size check · duplicate/self-cross detection · available balance verification · symbol tradability and min-notional check · per-venue rate-limit budget check.

### Continuous monitors
- **Daily loss limit** → global halt
- **Max drawdown from high-water mark** → global halt
- **Per-strategy loss limit** → disable that strategy only
- **Consecutive-loss breaker** → cool-down period
- **Market-data staleness** → cancel all resting orders for that venue
- **Balance reconciliation mismatch** → halt and alert (our model of reality is wrong)
- **Liquidation-distance warning** on any leveraged position → auto-deleverage

### Kill switch
Cancels everything everywhere, optionally flattens, sets global halt. Available in the dashboard header at all times, via CLI, and via a standalone HTTP endpoint. Additionally, **exchange-side dead-man's timers**: Binance, Bybit, and OKX all support auto-cancel-on-disconnect. We register it, so if our process dies entirely, the exchange cancels our resting orders without us. This is the backstop for the scenario where our own kill switch is unreachable because the box is gone.

### Security
Keys encrypted at rest with libsodium sealed boxes; master key from environment or OS keychain, never in the DB or repo. The dashboard writes keys but never renders them back. On save, we call the venue's permission endpoint and **refuse to enable any key with withdrawal permission**, with a link to instructions for fixing it. IP whitelist strongly recommended and prompted for. Full audit log of every config change.

---

## 7. Capital & account management

This is the treasury layer: what we hold, where it sits, who it belongs to, and what it's earning. It runs fully automated — no manual balance entry, ever.

### Object model

```
Musket Goose ──── wholly owns ───→ Fund (one NAV, no fractional stakes)

Fund ─┬─ Venue Account ─┬─ API Credential (encrypted, trade-only)
      │  (exchange +    ├─ Balances (per asset, free/locked)
      │   subaccount)   ├─ Positions
      │                 └─ Fee tier / volume
      └─ Wallet (on-chain, read-only address watch)
```

A **Venue Account** is one API credential on one exchange (or subaccount — Binance, Bybit, and OKX all support subaccounts, and using one subaccount per strategy is the cleanest way to get true per-strategy attribution and blast-radius isolation).

### Ownership — superseded

> **Corrected 2026-07-21.** This section originally described several operators each holding units of a pooled NAV, with per-person stakes. That is not the structure. **The fund is wholly owned by Musket Goose** — no fractional stakes, no members. Trading decisions come from rules and models, not from a person.
>
> Per-person accounting was removed entirely, including the "recorded by" field on capital events. Without authentication that name is self-selected and unverified: it has the appearance of an audit trail without the substance, which is worse than none because it invites trust it cannot support. Real attribution arrives with real sessions.

What survives from the unit model, repurposed, is the **performance index**.

Units change only when capital moves, so NAV-per-unit is unaffected by deposits and withdrawals — it moves on trading P&L alone. That makes it a time-weighted return, and it answers the one question a balance cannot: *is the strategy working?* On a raw balance, adding $5,000 and earning $5,000 look identical. The index separates them.

So the ledger tracks one balance, priced against an index that starts at 1.0000.

### Automated sync

- **Balance poller** — every venue, every 30s, plus immediate refresh on any fill. Free/locked/total per asset.
- **Deposit & withdrawal detection** — polls venue transfer history; new external deposits are surfaced for classification as an operator contribution rather than silently changing NAV. An unexplained balance change should never be quietly absorbed.
- **Internal transfer matching** — moves between our own venues are matched into a single transfer record so they don't appear as a withdrawal plus an unrelated deposit.
- **Fee tier sync** — pulls current tier and 30-day volume per venue, which feeds the cost model the strategies use for edge calculations.
- **Reconciliation** — computed balances vs exchange-reported, continuously. Drift beyond tolerance halts trading and alerts.
- **Valuation** — everything marked to a common quote currency (USD) on a consistent price source so NAV is comparable across venues.

### Adding an account (the onboarding flow)

1. Pick exchange → paste API key + secret (+ passphrase where required)
2. System immediately calls the venue's permission endpoint and **hard-blocks the key if withdrawal is enabled**, with fix instructions
3. Shows our current egress IP for whitelisting, with a copy button
4. Auto-discovers: balances, open positions, open orders, tradable markets, fee tier, subaccounts
5. Label it, assign a purpose (which strategies may use it), set a per-venue exposure cap
6. Runs a connectivity + latency test and a tiny signed read to prove the credential works end to end

### Rebalancing

Capital drifts across venues as strategies trade. A rebalancer proposes moves when a venue's allocation deviates beyond a band, choosing the cheapest transfer route (network fees vary enormously — moving USDC on Arbitrum vs USDT on Ethereum is often a 50x cost difference) and executing only when the deviation cost exceeds the transfer cost. **Proposals require explicit approval by default** — automated withdrawals are the one place where full autonomy is genuinely dangerous, and our API keys can't withdraw anyway.

### The capital ladder

The system must behave sensibly at $100 and at $100,000 without being reconfigured by hand. So capability is **gated on NAV**, and the ladder is a first-class object the engine reads on every decision.

The reason this matters is arithmetic. Exchange minimum order sizes are typically $5–10 notional, and round-trip fees are ~0.2%. On a $10 minimum order, a healthy 0.25% edge is **2.5 cents gross against 2 cents of fees**. That is not a strategy, it's noise — and it's why "just trade smaller" doesn't work below a floor. Fees and minimums don't scale down with your account.

So the honest answer for very small balances is not "trade badly", it's "trade *narrowly* and spend the time proving edge". Tier 0 still makes real decisions on real data every second — it just records them instead of paying the fee drag to act on them.

| Tier | NAV | What unlocks | Rationale |
|---|---|---|---|
| **T0 · Seed** | $0–500 | All strategies run in **shadow**. Full data recording, live opportunity scoring, paper PnL. Optionally **one** live micro-position at exchange minimum — as an end-to-end plumbing test of the order path, not a profit centre. | Below this, fees and minimums exceed almost every edge. The valuable output is *evidence*, not returns. |
| **T1 · Starter** | $500–2.5k | Funding carry live, one venue, 1–2 majors. Low-risk tier only. Single position at a time. | One strategy, one venue — the simplest thing that can genuinely work. |
| **T2 · Core** | $2.5k–10k | Multi-venue funding carry, cross-venue funding spread, stablecoin peg. Medium tier at ≤15%. Concurrent positions. | Enough capital to hold margin on two venues simultaneously. |
| **T3 · Expansion** | $10k–50k | Cross-venue spot spread (pre-funded inventory), basis/calendar. High-risk tier unlocked at ≤5%. | Inventory on multiple venues finally clears minimums. |
| **T4 · Scale** | $50k–250k | Market making, meta-allocator, wider venue set. Paid low-latency infra now justifiable. | Fee tiers improve; maker rebates become real income. |
| **T5 · Institutional** | $250k+ | Full strategy set, VIP fee tiers, colocation worth evaluating. | |

**Promotion** requires NAV to hold above the threshold for 7 consecutive days, so a lucky spike doesn't unlock leverage. **Demotion is immediate** on breach — protecting capital shouldn't wait for confirmation. This asymmetry is deliberate.

Tier thresholds and their unlocks are all editable in the dashboard; the defaults above are a starting position, not a law. The dashboard shows current tier, progress to the next, and exactly which capabilities the next tier unlocks — so the ladder doubles as the system's roadmap.

Independently of tier, a universal **minimum-viable-trade filter** rejects any order where `expected_edge × size < fees + expected_slippage + minimum_notional_drag`. This runs at every tier and is the real protection against small-balance value destruction.

---

## 8. Dashboard specification

This is the part you emphasized, so it's specified in detail. Design language: **dark-first**, information-dense, tabular numerals throughout, all timestamps UTC with relative hover, teal/amber rather than green/red alone for colorblind safety, `⌘K` command palette for everything. Live updates via WebSocket with visible connection state and automatic reconnect. Every number that could be stale shows its age.

### 1 · Command Center
The at-a-glance screen. NAV curve with selectable window; today's PnL broken out by strategy and by venue; exposure gauges (gross, net, per-asset delta); a live status grid of every strategy with its tier badge, state, and today's contribution; open positions summary; recent fills ticker; active alerts; and a venue health strip showing connection state, latency, and rate-limit headroom per exchange. **Kill switch is pinned in the header on every page.**

### 2 · Opportunities
The trust-building screen, and the one I'd argue matters most early. A live feed of every opportunity every scanner detects — gross edge, estimated fees, estimated slippage, **net edge**, and the decision: taken, or rejected with the specific reason (below threshold, insufficient balance, risk veto, venue degraded). Shadow-mode strategies appear here alongside live ones. This is how you learn whether an edge is real before risking anything on it, and how you debug why the system isn't trading.

### 3 · Strategies
A card per strategy: on/off toggle, mode selector (shadow / paper / live), risk tier badge, capital allocation slider, and a parameters form **generated automatically from the strategy's Pydantic schema** so new strategies need no bespoke UI. Per-strategy equity curve, Sharpe, hit rate, average edge captured versus predicted (a key diagnostic — divergence means the cost model is wrong), fill statistics, and trade history.

### 4 · Positions & Portfolio
Positions per venue and aggregated. Delta exposure by underlying asset — critical for confirming "delta-neutral" strategies actually are. Net and gross exposure, leverage per venue, accrued funding, and liquidation-distance warnings with clear visual escalation.

### 5 · Orders & Fills
Complete audit trail, filterable by strategy, venue, symbol, and time. Each order expandable to a **latency breakdown**: signal generated → risk approved → submitted → acknowledged → filled. This is how execution quality gets diagnosed.

### 6 · Exchanges
Per venue: enable/disable, API key entry (write-only fields), automatic permission verification with a hard block on withdrawal-enabled keys, IP whitelist helper showing our current egress IP, current fee tier and 30-day volume, balances by asset, rate-limit budget meter, latency history chart, and granular toggles for which market types (spot, perp, margin) and which symbols are enabled.

### 7 · Risk
Every limit editable with live utilization bars showing current consumption against each. Breach history, circuit-breaker states with time remaining on cool-downs, and full kill-switch history with who/when/why.

### 8 · Backtest & Research
Select strategy, params, symbols, and date range; run; review equity curve, drawdown, trade list, and fee/funding breakdown. Parameter sweep with a heatmap for sensitivity — a strategy that only works at one exact parameter value is overfit, and the heatmap makes that obvious at a glance. Walk-forward analysis. Compare runs side by side.

### 9 · Ledger & Tax
Every cash movement, fee, funding payment, and transfer, exportable to CSV. Non-negotiable for tax, and the ground truth when PnL attribution is disputed.

### 10 · System Health
Structured log stream with filtering, per-service status, WebSocket reconnect counts, error rates, database size and ingest lag, and alert channel configuration (Telegram and Discord — Telegram is the practical choice for phone alerts).

### 11 · Settings
Global config, notification routing and severity thresholds, users and 2FA.

---

## 9. Backtesting — the part everyone gets wrong

A backtester that lies is worse than none, because it manufactures confidence. Ours models explicitly:

- **Maker vs taker fees** at our actual tier, per venue
- **Queue position** for maker orders — a resting order does not fill just because price touched it; it fills when the queue ahead of it clears
- **Slippage from real L2 depth**, walking the recorded book rather than assuming fills at the touch
- **Latency** — simulated per-venue delay between decision and arrival, so signals act on the book as it was, not as it is
- **Partial fills** and rejections
- **Funding payments** on the correct schedule
- **Survivorship**: delisted pairs stay in the dataset

A configurable "fill realism" setting runs optimistic through pessimistic assumptions; **if a strategy is only profitable under optimistic fills, it is not profitable.**

Paper trading mode then runs the identical code against live market data with simulated fills. Mandatory before any strategy sees real capital.

---

## 10. Build plan

Each phase ends with something demonstrably working. Estimates assume focused sessions, not calendar time.

| Phase | Scope | Est. |
|---|---|---|
| **P0 · Foundation** | Repo structure, Docker Compose, config system, encrypted secrets, DB schema and migrations, CCXT connectivity smoke test, **market data recorder running and accumulating** | 2–3 days |
| **P1 · Core engine** | Event bus, venue abstraction, OMS, simulated venue, risk engine, portfolio accounting, reconciliation | 4–6 days |
| **P2 · Dashboard v1** | Next.js app, auth, WebSocket live state, Command Center, Exchanges, Positions, Orders, **kill switch working end to end** | 5–7 days |
| **P3 · First strategy** | Funding carry, through shadow → paper → live-tiny. Strategy plugin interface proven by a real implementation | 3–4 days |
| **P4 · Backtester** | Replay engine with realistic fills, research UI, parameter sweeps, walk-forward | 4–6 days |
| **P5 · Scanners** | Cross-venue spread, stablecoin peg, triangular (shadow), Opportunities screen | 4–5 days |
| **P6 · Expansion** | Market making, directional strategies, meta-allocator, LLM regime layer | 6–8 days |
| **P7 · Hardening** | Alerting, dead-man switches, chaos testing (kill services mid-trade), runbooks, disaster recovery | 3–4 days |

**Sequencing rationale:** the recorder ships in P0 because every day it isn't running is a day of training data we can never recover. The kill switch ships in P2 — before any strategy exists — because the ability to stop must predate the ability to start.

### Go-live gate

No real capital until all of these hold:

- [ ] Strategy profitable in backtest under **pessimistic** fill assumptions
- [ ] Strategy profitable in paper trading over ≥2 weeks of live data
- [ ] Predicted edge matches realized edge in paper within tolerance
- [ ] Kill switch tested under load, mid-position
- [ ] Exchange-side dead-man's timers registered and verified
- [ ] Balance reconciliation clean for ≥7 consecutive days
- [ ] Every API key verified trade-only and IP-whitelisted
- [ ] Alerting verified end to end on a real phone
- [ ] Full recovery from a hard process kill with open positions, tested
- [ ] Position sizing starts at ~10% of intended, scaling only on clean live evidence

---

## 11. Known risks

| Risk | Mitigation |
|---|---|
| Exchange insolvency / withdrawal freeze | Split capital across venues; cap per-venue exposure; no venue holds a majority |
| Strategy bug drains account | Hard risk gate; position limits; daily loss halt; start at 10% size |
| Perp liquidation on a "neutral" position | Low leverage, auto-margin-top-up, liquidation-distance alerts, auto-deleverage |
| Funding flips against carry position | Continuous monitoring with automatic unwind threshold |
| Market data gap causes trading on stale prices | Staleness detector cancels orders; heartbeat monitoring |
| Overfitting in backtest | Walk-forward, parameter heatmaps, pessimistic fill assumptions, paper gate |
| Infra cost exceeds returns | Start local/cheap; scale hosting only against proven returns |
| Key compromise | No-withdrawal keys, IP whitelist, encrypted at rest, audit log |
| Silent divergence between our state and exchange | Continuous reconciliation; mismatch halts trading |

---

## 12. Open decisions

1. **Venue set for phase 1** — I'd suggest Binance + Bybit + Hyperliquid. Binance for liquidity and free historical data, Bybit for its funding characteristics and good API, Hyperliquid for on-chain perps with no KYC friction. Adding OKX later is straightforward.
2. **Alerting channel** — Telegram recommended; simplest reliable path to phone notifications.
3. **Hosting** — recommend running locally through P4, then a cheap VPS, then Tokyo only if justified.
4. **LLM regime layer** — deferred to P6. Worth building, but it is a refinement on top of a working system, not a foundation.
