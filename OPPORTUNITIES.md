# Opportunities — the living ledger

**Standing orders (for the agent):** read this file at the start of every
session, before choosing work. Update it at the end of every session: move
shipped things to SHIPPED, re-rank NEXT UP, add new ideas with a dated
verdict. This file is the answer to "what have you done, what are you doing,
what should we do next" — if it isn't written here, it didn't happen.

**The operating constraint:** everything on this list must be able to run
itself. Ideas may require buying hardware or signing up for services — those
are documented with costs and payback so the operator can decide — but the
ongoing operation must be code, not chores.

**The method still applies:** evidence before capital, for hardware exactly
as for strategies. A payback estimate in a blog post is a claim, not
evidence; where we can measure before buying, we measure first.

---

## 0. Since the merge (2026-08-26)

The arbitrage system and this one are now one product with two desks, so this
ledger covers both. Full reasoning and sources:
[`docs/research/2026-08-opportunities.md`](docs/research/2026-08-opportunities.md).

**New, ranked above everything except going live:**

- **E6 · Polymarket × Kalshi cross-venue prediction arbitrage — DO.** The one
  genuinely new opportunity the merge unlocked. Kalshi is available in South
  Africa (not among its 54 restricted jurisdictions); Polymarket already works
  from here. Kalshi's taker fee is `0.07 x p x (1-p)` — the *same functional
  form* as Polymarket's, so the fee model already generalises and there is a
  test asserting it. Matcher, effective-odds conversion, depth model, scoring
  and board all reuse. Missing: one read-only market adapter, a resolution-risk
  axis (UMA oracle vs regulated criteria can resolve the same event
  *differently*), and an annualised-return term, because profit is locked until
  resolution and an 8c spread over a year is not an 8c spread over 90 days.
  Verify with a tiny funded account before building — Kalshi requires full KYC
  and several "supported" countries have since blocked access.
- **E2 · third and fourth sportsbook — DO, in parallel.** Two books measured
  zero arbitrage across 197 markets, best gap -1.3%. More books is the honest
  experiment; the discovery method is written down and has worked twice.

**Re-confirmed against external 2026 guidance, no verdict changed:** funding
carry best-for-retail; cross-venue spread an execution project we would lose;
triangular educational; dated basis predictable but capital-intensive;
statistical arb not for retail. The ledger is well calibrated.

**Newly rejected:** in-play sports arbitrage (seconds-long windows against a
manual-placement charter — incompatible, not hard); narrow fast
prediction-market gaps (a bot fight; we would be the retail entrant funding the
winners, the same argument that rejected MEV).

**Also shipped 2026-08-26, for the deployment box specifically:** a Windows
bootstrap, a build-memory cap, `pnpm bundle` (a prebuilt console needing only
Node — no package manager, no build, no Docker, and platform-independent), the
`docs/deploy-old-machine.md` walkthrough, and a fix to the polling hook that
left the execution-mode badge blank for a minute after signing in.

**Shipped in the deployment-readiness pass (2026-08-26).** One execution seam
deciding which money is at risk; one kill switch reaching both desks; one pool
and one database name; the stake-plan rounding bug; preflight, `.env.example`
and a bootstrap that survives a cold box; self-hosted typography, so no build
depends on the network; a test suite that runs on the deployment machine rather
than only on the machine it was written on; pinned Python dependencies; a
repaired lockfile; and `docs/` with an index. Full detail in
[`docs/changelog.md`](docs/changelog.md). The verdicts above are unchanged by
any of it.

---

## 1. Next up — ranked (the agent's recommendation, updated 2026-07-26)

1. **Go live with small real capital** — the single highest-EV item on this
   list and the only one that turns the machine we already built into actual
   income. The paper book earns simulated money; every day it performs is
   evidence, but R0 of it is real. Needs: an exchange account (Binance or
   VALR for ZAR on/off-ramp) + trade-only API keys, and the A4/A6 work
   (live venue adapter + reconciliation) that is deliberately sequenced
   before the first real order. **Operator action: exchange account +
   trade-only API keys when ready. Start tiny — a few hundred rand.**
2. **M2 dated-futures basis execution** — a second delta-neutral income
   stream already scored live every pass, deterministic at settlement,
   structurally safer than funding carry. ~1 day of careful engine work
   (dated-future instrument, expiry settlement, convergence accrual).
   No purchases, no sign-ups.
3. **S1 staked-carry research (new strategy idea, 2026-07-26)** — ETH
   staking yields ~3.2–4% while a perp short cancels the price risk;
   staking yield + funding (when positive) − borrow/hedge costs is a
   delta-neutral carry that most retail never structures. Backtestable
   NOW with free data (staking APR history + our funding history) before
   any real ETH is involved. If the backtest clears costs, it becomes the
   third carry engine and scales with real capital when we go live.
4. **Fear & Greed regime feature + derivatives positioning recorder** —
   free data that sharpens the ML veto (full F&G history is backtestable
   immediately; open-interest/long-short data must be recorded now because
   venues only serve ~30 days of it).
5. **Telegram alerting** — not income, but the operator's eyes on the
   income: fills, halts, re-validation alerts pushed to your phone.
   **Operator action: create a bot with @BotFather (~2 min), paste the
   token.**

## 2. In flight

- Paper fund running the R30,000 seed: 5-minute loop, **5 open positions
  across all three accounts** after the 2026-07-26 ladder realignment —
  BNB + DOGE funding carries (Conservative, two venues), USDJPY + USDCHF
  interest carries, EURUSD trend (Experimental tuition). H1 (Aggressive)
  is armed and waiting for a genuine 100-day breakout — absence of signal,
  not blockage.
- Automated re-validation grading all five strategies every ~12h (7 runs
  recorded so far, alerts working).
- ML prediction ledger: ~256 pending; first grades mature ~2026-07-30,
  then the veto can start earning promotion.
- Ladder promotion clock now honest: 3/7 days held toward T1.

## 3. Shipped (dated, newest first)

- **2026-07-26 · Tier ladder realigned with the charter** — found and fixed
  the freeze: the pre-charter ladder allowed only L1+F1 with ONE position
  per account at this NAV, so the first two entries starved every other
  funded book for three days (6,131 position-limit rejections). T1 now
  admits the charter-funded strategies with three slots per account; the
  book entered 5 positions within one pass of the fix. Also fixed the
  promotion clock always reading 0/7 (base-tier early-return swallowed the
  fall-through).
- **2026-07-26 · Opportunities ledger + income research sweep** — this
  file; GPU rental BUY?, mining/storage/bandwidth/DePIN rejected on
  numbers.
- **2026-07-23 · Automated re-validation** — backtests run themselves every
  12h, health-grade every strategy, alert on capital-vs-evidence mismatch.
- **2026-07-23 · FX universe widened** — NZD/SEK/MXN added behind punitive
  spread tolls; backtest immediately rejected MXN carry (doesn't clear its
  toll); scan now scores 61 candidates/pass.
- **2026-07-23 · R30,000 fresh start** — every portfolio funded per charter;
  first fills seconds after restart.
- **2026-07-23 · Go-live sweep** — no demo content, favicon, glossary tips,
  System page honesty pass.
- **2026-07-23 · Portfolio governance** — charter caps, isolation halts,
  reason-logged capital moves, Portfolios page.
- **2026-07-22/23 · The evidence pipeline** — 7 strategies backtested with
  live signal code; L2/F2/B1 defunded by their own numbers; H1 funded and
  later re-confirmed at +17.2%/yr over 1,000 days.
- **2026-07-22 · Self-grading ML** — persistence model, prediction ledger,
  earn-the-veto promotion gate.

## 4. Avenues researched — verdicts (2026-07-26)

Every idea gets a verdict: **DO** (build it), **BUY?** (works, needs a
purchase — operator decides), **WATCH** (re-check when conditions change),
**REJECTED** (measured or researched, doesn't clear the bar). Verdicts are
dated and re-arguable with new evidence — like every other verdict here.

### In-system (no purchases)

| Idea | Verdict | Why |
| --- | --- | --- |
| M2 basis execution | **DO** | Scored live already; deterministic convergence; second income engine. |
| S1 staked carry (ETH yield + short hedge) | **DO (research)** | ~3.2–4% base yield, delta-neutral structure, backtestable free. |
| Meta-labeling ML on our own fills | **WATCH** | Right move at ~200 completed trades; premature now. |
| More venues for L1/L2 (Gate, Bitget…) | **WATCH** | More funding spreads to compare; marginal until real capital. |
| MEV / on-chain arbitrage | **REJECTED** | Dominated by specialists with colocation and private orderflow; retail entrants fund the winners. |
| Airdrop farming automation | **REJECTED** | ToS-gray, sybil-filtered heavily in 2026, effort-heavy, declining yields — not the reputation risk for the money. |

### Out-of-system (hardware / capital purchases)

| Idea | Verdict | Numbers (researched 2026-07) |
| --- | --- | --- |
| **GPU rental** (Vast.ai / Salad) | **BUY?** — the one hardware idea that clears the bar | RTX 4090 (~R40–48k in SA) nets roughly $200–300/mo at 40–50% utilization after electricity; verified hosts report ~$180/mo gross conservative, up to $400–900/mo at high utilization. Electricity is the kill-factor for most side hardware, but GPU rental revenue/kWh is high enough that SA's ~R3.5/kWh only costs ~R400/mo. Honest payback: **12–20 months**, NOT guaranteed — utilization depends on verification, 100Mbps+ upload, and uptime (load shedding is a real reliability risk to the host rating; a UPS becomes part of the bill). Fully automatable: listing, pricing, monitoring all scriptable. |
| Bitcoin/crypto mining | **REJECTED** | Breakeven is ~$0.06–0.10/kWh on current-gen ASICs; SA residential power ~R3.5/kWh ≈ $0.19 is **2–3× over breakeven**. Home mining loses money in 2026, full stop. Only worth revisiting with free solar overproduction. |
| Storage rental (Storj/Sia) | **REJECTED as purchase, WATCH as freebie** | $1.50/TB/mo stored + $20/TB egress sounds fine until you learn nodes take months to fill and realistic income is a few dollars/TB/mo. Never worth buying disks for; barely worth the electricity on an already-running machine. |
| Bandwidth sharing (Grass, Honeygain) | **REJECTED** | $5–20/mo, sells your residential IP to scrapers, likely violates ISP ToS. Not for that money. |
| Helium / DePIN hotspots | **REJECTED for SA** | The $80–150/mo stories are dense US cities; SA coverage demand is thin and most non-US operators report $2–10/mo. Token-denominated, hardware upfront. |
| ETH solo staking (32 ETH) | **WATCH** | ~3.2–4% APR is real but the capital bar (~$100k+) is ours-someday, not now; the S1 staked-carry research above captures the same edge at fundable size via liquid staking tokens — evidence first. |

### The honest headline

Nothing out-of-system beats accelerating the in-system path. GPU rental is
the only researched purchase with a credible payback, and its ~R4k/mo
ceiling is what the fund itself should out-earn once live capital compounds
through validated carry. The out-of-system list exists so we never re-argue
these from vibes — each has a dated verdict and a re-open condition.

## 5. Operator actions pending (each ~2 minutes unless noted)

- [ ] Telegram bot token (@BotFather) → alerts to your phone.
- [ ] CryptoCompare free API key → news-sentiment feature for the ML.
- [ ] Decide on GPU rental (R40–48k + UPS; 12–20 month payback, not
      guaranteed) — if yes, the agent scripts the entire host setup.
- [ ] When ready to go live: exchange account (Binance / VALR) with
      **trade-only** API keys (never withdrawal-enabled), small seed.
- [ ] Later, optional: Anthropic API key (~$1/mo) for the news/regime
      classifier described in ML.md.
