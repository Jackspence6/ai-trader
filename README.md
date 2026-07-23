# Meridian — autonomous trading platform

A self-hosted, self-improving trading system. It scans live markets across
four crypto venues and seven FX pairs, scores every opportunity through a
tested cost and risk model, paper-trades what survives, manages exits,
tracks P&L to the cent — and **grades its own decisions so it stops
repeating mistakes**.

Everything is real except the money: live prices, live funding, real fills
against a pessimistic simulated venue, real P&L attribution. Paper first,
by design — capital unlocks only through the evidence ladder.

## Run it

```sh
pnpm dev                        # dashboard on :3000 (password in .env.local)
pnpm trade -- --interval 300    # the always-on trading loop (one instance!)
pnpm record                     # the market-data recorder
docker compose up -d            # Postgres/Timescale (NAV history, tier ladder)
pnpm test · pnpm lint · pnpm build
```

Restart the loop after any engine change — it loads code once. Kill with
`pgrep -f "scripts/trade.ts" | xargs kill -9` and verify exactly one leaf
process remains (`ps ax | grep preflight.*trade`).

## How it decides (the evidence hierarchy)

Every strategy is backtested on real history with the live signal code and
honest costs, and **capital sits exactly where the evidence points**:

| Strategy | Verdict | Allocation |
|---|---|---|
| F1 FX carry | Earns (+4.3%/3y, Sharpe 0.62, both components positive) | $3,500 |
| L1 crypto funding carry | Breakeven at taker; positive at maker; stable parameter plateau | $6,000 (core) |
| L3 stablecoin peg | Near-riskless when it fires; silent otherwise | core |
| L2 cross-venue spread | Structurally negative (spread mean-reverts in ~1 day) | scored, not sized |
| F2 FX trend | Negative in all 12 parameter cells | defunded, scored in shadow |

## The machine learning (free, self-improving)

`lib/ml/` — a deliberately small, deterministic funding-persistence model:

1. **Trained** on free Binance funding history, retrained every pass.
2. **Walk-forward validated** (beats the median-rule baseline out-of-sample:
   89.9% vs 87.4% precision when confident).
3. **Graded live**: every prediction is written to a permanent ledger and
   scored 7 days later against what funding actually did — including the
   counterfactuals (trades it would have rejected that then earned).
4. **Autonomy is earned**: the model starts in SHADOW. When its matured live
   record beats the baseline over 40+ samples it is promoted to CONFIRMING
   and may *veto* weak carry entries; if its edge decays it is demoted
   automatically. It never generates a trade (DESIGN.md principle 7).

## Screens

Overview · Markets · Performance (P&L attribution) · Opportunities (every
decision with its reason, incl. the model's persistence column) ·
Positions · Strategies · Allocation · Exchanges · Parameters · Risk ·
Treasury · Backtests (all verdicts, sweeps, the model's live record) ·
System (loop health, recorder). ⌘K opens the command palette.

## What's free vs what will cost money later

**Free forever (current):** all market data (Binance/Bybit/OKX/Hyperliquid
public APIs, Frankfurter ECB fixes), the ML (local, dependency-free),
Postgres in Docker, the dashboard.

**Planned spend, when the evidence justifies it:**
- Claude API regime classifier (~$1/mo, Haiku) — risk multipliers, never orders
- Telegram alerts (free, needs a bot token — ask when wanted)
- Exchange accounts + API keys (free; needed for live micro-positions)
- Maker-fee tiers / Tokyo VPS ($5–12/mo) — only after live edge is proven

## Docs

- `DESIGN.md` — architecture and principles (the honest economics up front)
- `STRATEGY.md` — what we trade and why
- `ROADMAP.md` — done / in flight / next, with dated findings
- `ML.md` — the machine-learning plan: what to build, costs, who does what
- `GOVERNANCE.md` — the multi-portfolio operating charter: caps, isolation, promotion
- `EXPANSION.md` — venue and strategy expansion notes
