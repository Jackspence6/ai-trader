# Expansion — more ways to make money

**Question:** what else can this system trade to make money, given what it is?
**Companions:** `STRATEGY.md` (what we trade and why) · `ROADMAP.md` (what is built)

This is a survey of every credible money-making avenue, scored against **our
actual constraints** and ranked by what to build next. The constraints are the
whole point — plenty of strategies make money for someone, and almost none of
them make money for a small, latency-blind, cost-sensitive, paper-first book.

---

## 0. The constraints every idea is judged against

1. **No latency edge.** We run on a serverless host and a polling loop. Anything
   that competes on speed (HFT spatial arb, sniping, sub-second triangular) is
   dead on arrival — we would be the liquidity, not the taker of it.
2. **Small size.** A few hundred to a few thousand dollars. Fixed costs (fees,
   minimum notionals, withdrawal fees) dominate. An edge that needs $100k of
   size to clear costs is not our edge.
3. **Cost-sensitive.** Round-trip costs are ~10–40bp. Only low-turnover, held
   positions amortise that to irrelevance. High-churn strategies bleed.
4. **Real data, paper-first.** Everything must be scoreable from a public feed
   and paper-tradeable honestly before any capital is at risk.
5. **Some risk, not excessive.** Delta-neutral and carry preferred. Directional
   is allowed in small, ring-fenced sleeves — never the main engine.

The pattern that survives all five is the same one the system already runs:
**get paid to hold a position other people don't want to hold.** Carry, basis,
funding, premium. That is the spine of everything below.

---

## 1. What we already run

| Code | Strategy | Class | Status |
|------|----------|-------|--------|
| L1 | Single-venue funding carry (spot long + perp short) | crypto | **Live (paper)** |
| L2 | Cross-venue funding spread | crypto | **Live (paper)** |
| F1 | FX interest-rate carry | forex | **Live (paper)** |

All three are "warehouse a risk, collect the premium." They work. The expansion
is more of the same shape, on more venues and more instruments — plus a small
number of genuinely different edges.

---

## 2. Ranked expansion — build order

### Tier A — do these next (high fit, low risk, real ROI)

**A1 · More perp venues (OKX, Gate, KuCoin, Bitget).**
The single highest-ROI change. L2 (cross-venue funding spread) gets *wider and
more frequent* with every venue added, because the widest spreads sit between a
mainstream venue and an alt-heavy one. OKX and Gate routinely show funding
extremes on alts that Binance/Bybit don't. Pure data integration — no new
strategy, no new risk model, it just deepens a book that already works.
*Edge: medium-high · Risk: low · Effort: medium (one adapter per venue).*

**A2 · Cash-and-carry basis (spot vs dated future).**
Buy spot, short the **quarterly** future when it trades above spot, and collect
the annualised basis, which converges to zero at expiry — a near-deterministic
payoff, often richer and steadier than perp funding. Binance and OKX list dated
quarterlies; Deribit is the deepest. This is the classic institutional carry and
it fits us perfectly: delta-neutral, low-turnover, deterministic.
*Edge: medium-high · Risk: low (convergence is mechanical) · Effort: medium
(dated-futures feed + expiry handling).*

**A3 · Stablecoin peg (L3 — already scaffolded).**
Buy USDC/DAI a few bp below $1, unwind at the peg. Tiny per-trade edge, very low
risk, capacity-limited — but the sleeve and code stub already exist, so it is
the cheapest thing to finish. Good "always-on floor" income between richer
opportunities.
*Edge: low · Risk: very low · Effort: low (finish the existing stub).*

**A4 · More FX carry pairs + EM crosses.**
We follow the majors. The carry is in the high-yielders — MXN, BRL, INR, TRY vs
low-yield funders (JPY, CHF). Frankfurter/ECB doesn't cover EM well, so this
needs a broader FX source, but the carry is structurally larger. Handle with the
same swap-markup honesty that already keeps ZAR in check.
*Edge: medium · Risk: medium (EM currencies gap hard) · Effort: medium (data).*

### Tier B — worthwhile, more effort or more risk

**B1 · Options vol-carry on Deribit (short-dated covered calls / cash-secured puts).**
Sell the volatility risk premium — options are systematically priced above
realised vol, so disciplined premium-selling earns. Deribit has a clean public
feed. This is real, uncorrelated income, but it has genuine tail risk (a short
put in a crash) and needs a proper options model and margin logic. A ring-fenced
sleeve, sized small.
*Edge: medium-high · Risk: medium-high (tail) · Effort: high.*

**B2 · FX trend execution (F2).**
Already scored, not executed — it needs a stop-managed gate (the edge gate
doesn't fit a directional bet). Currencies trend on macro cycles uncorrelated
with crypto, so it's a real diversifier. Medium risk, ring-fenced.
*Edge: medium · Risk: medium · Effort: medium (build the trend gate).*

**B3 · Crypto trend / momentum (H/M sleeves — defined, not built).**
The Systematic and Opportunistic sleeves exist as mandates with no scanner.
Trend-following on majors is a legitimate, capacity-deep strategy, but it is
directional, drawdown-heavy, and wins <40% of trades — only defensible as a
small sleeve with hard stops. This is where "more return" actually lives, and
also where "excessive risk" lives, so it goes in deliberately and small.
*Edge: high variance · Risk: high · Effort: high.*

### Tier C — investigate, but expect the edge to be thin for us

**C1 · Cross-exchange spot spatial arb.** Same coin, different price across CEXs.
At our size and taker fees, and with withdrawal/transfer costs, the edge is
almost always eaten. Worth a *scanner* to confirm empirically, not capital.

**C2 · Triangular arb (within one venue).** BTC→ETH→USDT→BTC loops. Real but
fast and competitive — a latency game we lose. Scan-only at most.

**C3 · Stat-arb / pairs (e.g. the ETH/BTC ratio, mean-reversion).** A genuine
edge historically, but it is directional-in-disguise and needs careful modelling
and stops. A later research project, not a near-term build.

**C4 · DeFi/staking yield on idle stablecoin.** Real yield, but it is lending
and custody risk, not trading, and pulls the system into smart-contract and
bridge risk we've deliberately stayed out of. Out of scope.

---

## 3. The honest shape of the recommendation

The fastest, safest money is **breadth on what already works**: add venues (A1),
add the basis trade (A2), finish the peg (A3). That roughly triples the number
of carry opportunities the book can see without introducing a single new kind of
risk. Do that first.

Then, for genuine diversification rather than more of the same: **options
vol-carry (B1)** and **FX/crypto trend (B2/B3)** — each in its own small,
hard-stopped sleeve, because that is exactly the "some risk, not excessive"
line. The trend sleeves are the only place meaningfully higher returns come
from, and they come with meaningfully higher drawdowns; they are a deliberate,
sized choice, never the default.

Everything in Tier C is a scanner-first question: build the measurement, look at
whether the edge survives our costs, and only then decide. That is the same
discipline the whole system is built on — measure before you risk.
