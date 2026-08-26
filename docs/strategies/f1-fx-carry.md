# F1 — FX interest-rate carry

**Standing: FUNDED** (paper). The diversifier.

Full mechanics are in [`STRATEGY.md` §5b](../../STRATEGY.md).

## Thesis

Hold the higher-yielding of a currency pair against the lower and collect the
rate differential. It is the oldest carry trade there is, it is uncorrelated
with crypto funding, and it works until it very suddenly does not.

## The evidence

+4.3% over three years, Sharpe 0.62, with **both components positive** — the
carry and the spot drift each contributed rather than one masking the other.
That last part is why it is funded and F2 trend is not: a strategy whose backtest
is positive only because one leg carried a losing other leg is a strategy that
will surprise you.

## Where it fails

- **Carry unwinds are fast and correlated.** The historical failure mode of this
  trade is not a slow bleed; it is a week that takes years of accrual.
- **Rates are from ECB reference fixes**, not a tradeable feed. Slippage between
  fix and fill is a real cost and is modelled conservatively.
- **The whole book idles without the FX provider.** Preflight checks it and says
  so explicitly, because a silent FX outage looks identical to "no signal".
