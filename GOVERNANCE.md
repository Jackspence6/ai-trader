# Governance — the multi-portfolio operating charter

**Status:** 2026-07-23 · Operator mandate, adopted as binding architecture.
**Companions:** `DESIGN.md` (principles) · `ROADMAP.md` (sequencing) · `ML.md` (model governance)

This document records the operator's instructions for how the system is
structured and governed, mapped onto what exists. Future work follows this
charter; deviations require a written reason here.

---

## 1. Multi-portfolio architecture

The system is a collection of **independent portfolios**, not one account.
Portfolios are risk-profile groupings; **sleeves** (the existing machinery)
are the strategy-level books inside them. Each layer keeps its own capital,
limits, halt state, and record.

| Portfolio | Risk profile | Member sleeves | Capital cap | Max drawdown |
|---|---|---|---|---|
| **Conservative** | Capital preservation, market-neutral income | core (L1/L3), fx-carry (F1) | ≤ 85% of NAV | 6% |
| **Aggressive** | Directional, higher variance, defined stops | systematic (H1) | ≤ 25% of NAV | 15% |
| **Experimental** | Unproven ideas earning their evidence | accumulation, opportunistic, fx-trend | ≤ 10% of NAV | 10% |

(Current NAV is small; "Balanced" as a distinct portfolio collapses into the
weighted whole and is reported at fund level. A "High-Risk" portfolio opens
only when a strategy earns it — capped ≤ 5% of NAV by charter.)

**Isolation:** a portfolio breaching its drawdown halts *its member sleeves
only* — enforced in the risk engine every pass, exactly like sleeve and fund
limits. One portfolio's failure must never cascade.

## 2. Capital allocation

Allocation is an optimization problem answered with evidence: realized
performance, risk-adjusted returns, drawdowns, correlation, regime, and
capacity. Reallocation happens only with recorded justification — **every
allocation change carries a written reason in the audit log.** No single
strategy or portfolio may absorb capital beyond its charter cap.

## 3. Promotion and demotion

The pipeline every strategy walks (no skipping):

```
Research → Backtest → Paper (shadow-scored) → Experimental (small capital)
        → Core allocation → (deterioration) → flagged → reduced → retired
```

Standing today: F1/L1/H1 hold core-level allocations on backtest + live
evidence; L2/F2/B1 were demoted to shadow **by evidence**, with the verdicts
recorded in ROADMAP.md. The ML model walks the same ladder (SHADOW →
CONFIRMING via the prediction ledger). Deterioration flagging is the next
build: live expectancy per strategy over a rolling window, with automatic
flag → reduce → retire recommendations.

## 4. Risk governance

Any high-risk recommendation must arrive with: quantified risks, downside
scenarios, why the allocation is justified, the maximum acceptable loss,
and a size consistent with the portfolio's risk budget. High-risk capital
is capped by charter and can never threaten system survival — the layered
limits (per-trade stop → sleeve drawdown → portfolio drawdown → fund
drawdown/daily-loss → global halt) are the enforcement, not the intention.

## 5. Reporting

The dashboard must show: total capital, per-portfolio allocation, available
cash, open/closed positions, P&L over day/week/month/year, unrealized vs
realized, win rate, profit factor, Sharpe, drawdown, exposure by asset and
market, portfolio correlation, strategy health, and alerts. Much exists
(Overview, Performance, Risk); the gaps — calendar P&L splits, live profit
factor/Sharpe per portfolio, correlation matrix, strategy health states —
are tracked in ROADMAP.md as the reporting workstream.
