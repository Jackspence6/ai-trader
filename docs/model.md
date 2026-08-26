# The model

## What it is, and what it is not

There is no large language model in the trading path, and that is a rule rather
than a gap (`DESIGN.md` principle 7). Non-determinism belongs nowhere near order
generation.

What exists is a small, deterministic **funding-persistence model** in
`lib/ml/`. It answers one question: *given what funding has done on this venue
and asset, is the current rate likely to persist over the next week?* It is
trained on free Binance funding history, retrained every pass, and it has no
dependencies beyond the standard library.

It cannot generate a trade. It can only **veto** a weak carry entry, and only
once it has earned the right to.

## Why it is allowed to veto and not to enter

A model that generates entries has to be right about direction, size and timing.
A model that vetoes only has to be right about one thing — whether an edge the
engine already found is likely to survive — and when it is wrong the cost is an
opportunity missed rather than a position taken. Those are very different risk
profiles for the same accuracy.

## How autonomy is earned

```
SHADOW  →  CONFIRMING  →  (demoted automatically if the edge decays)
```

- **SHADOW.** Every prediction is written to a permanent ledger. The model
  annotates opportunities and changes nothing.
- **Graded live.** Seven days later each prediction is scored against what
  funding actually did — *including the counterfactuals*, the trades it would
  have rejected that then earned. A model graded only on what it approved
  cannot be shown to be adding anything.
- **CONFIRMING.** When the matured live record beats the median-rule baseline
  over 40+ samples, it may veto. Walk-forward validation put it at 89.9% vs
  87.4% precision when confident, out of sample.
- **Demotion is automatic.** If the edge decays it loses the veto without anyone
  deciding to take it away.

## Reading the decision log

Every prediction lands in the ledger with its inputs, its output, its confidence
and, once matured, its grade. In the console:

- **Opportunities** — the persistence column on each scored row, and the
  rejection reason when something was turned down;
- **Research** — the model's live record, the baseline it is measured against,
  and its current standing;
- **Strategies** — which strategies the veto currently applies to.

Every rejection carries a code and a detail string, so "why did we not take
that?" is answered from the record rather than reconstructed.

## Guardrails that are code, not prompt

There is no prompt to weaken, but the general principle still holds — the limits
are enforced structurally:

- the model's output is a probability and a confidence, and both are bounded at
  the parse site;
- it is consulted **after** the risk gate, never before, so it cannot widen a
  limit;
- it can only move a decision from "take" to "skip", never the reverse;
- its standing is read from the graded ledger on every pass, so a stale
  promotion cannot persist across a restart.

## Adjusting it safely

Retraining happens every pass and needs no intervention. To change its
behaviour:

- **thresholds** live in `lib/ml/persistence.ts` and are covered by tests;
- **standing** is derived, not set — you cannot promote it by hand, which is
  deliberate;
- to take the veto away entirely, demote by clearing the ledger's matured
  window; it returns to SHADOW and keeps recording.

## What it does not do

It does not classify market regime, read news, or size positions. A Claude-based
regime classifier is a *planned* addition (~$1/month, Haiku) that would set risk
multipliers and never touch orders. It is not built, and the Strategies screen
says so rather than implying otherwise.
