# L1 — Perpetual funding carry

**Standing: FUNDED** (paper). The core Asset Markets strategy.

Full mechanics, entry and exit rules, the precise economics and the cost model
are in [`STRATEGY.md` §2](../../STRATEGY.md). This page covers what an operator
needs on top of that: the parameters, how to tune them, and where it fails.

## Thesis in one paragraph

A perpetual future has no expiry, so an exchange keeps it near spot by paying
funding between longs and shorts. Hold the perp short and the spot long and the
price exposure cancels; the funding accrues. It is a carry trade, not a
directional one, and it earns whenever funding stays positive for longer than
the round trip costs.

## Parameters that matter

| Dial | Where | Effect of raising it |
|---|---|---|
| Minimum net APR | `lib/engine/config.ts` | Fewer entries, each with more cushion against a funding flip |
| Minimum hold | config | Fewer round trips, so fees amortise — but slower to exit a decaying rate |
| Max per-venue exposure | `lib/calc/gate.ts` | More concentration on the best rate, less venue diversification |
| Slippage assumption | `lib/calc/costs.ts` | More conservative scoring; below-reality values invent edge |

The parameter plateau matters more than any single value. A sweep found the
strategy stable across a wide region rather than peaked at one setting, which is
the signal that the edge is structural rather than fitted.

## Where it fails

- **At taker fees it is breakeven.** The edge is real at maker fees, which needs
  a fee tier the fund does not have yet. This is the honest reason it earns
  little on paper.
- **Funding flips.** The exit rules close on inversion rather than waiting.
- **The model's veto.** Once CONFIRMING, the persistence model can veto weak
  entries — see [the model](../model.md). It cannot create one.
