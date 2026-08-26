# Paper and live

## What paper actually is

Paper is not a simulation of the system — it *is* the system, with one component
swapped. The same strategy code, the same scoring, the same risk gate, the same
sizing, the same accounting, the same model. The only difference is which
implementation of the `Venue` interface the loop holds.

That claim is enforced by the type system, not by discipline. The pass pipeline
is typed to `Venue`, the interface, and both `SimulatedVenue` and
`ExchangeVenue` implement it. If a code path only worked on paper it would not
compile against the interface.

> This was not free. Before this pass the pipeline was typed to
> `SimulatedVenue` concretely, though it only ever calls `submit()` — so a live
> venue could not have flowed through it, and the live path would have failed to
> compile at the exact moment someone wanted it to work. Paper mode's whole
> claim was being quietly contradicted by the types.

## What the simulated venue does differently

It fills pessimistically, on purpose:

- fills cross the spread rather than resting at mid;
- a configurable latency is applied before the fill is priced;
- the fee table is taker, not maker;
- size is capped by the book snapshot, so a fill cannot exceed the depth that
  was actually quoted.

The bias is deliberate. A paper book that fills better than reality produces an
edge that evaporates on the first real order, and you cannot tell which of your
strategies was real.

## Going live

Two independent switches, on the machine that will trade. Neither implies the
other, and that is the point.

```sh
# .env.local
MERIDIAN_EXECUTION=live        # 1. what the loop should do
ALLOW_MAINNET_TRADING=true     # 2. whether this box may touch real money
```

Then a credential must exist in the vault, its environment must be `mainnet`,
and the endpoint must be a mainnet endpoint. Every one of those is checked in
`lib/oms/venues/resolve.ts`, and any doubt at all resolves to paper with a
written reason.

Underneath that, three more gates run **per order** in
`lib/oms/venues/environment.ts`: the credential must be marked mainnet,
`ALLOW_MAINNET_TRADING` must still be true at the moment of the order, and the
call site must pass `confirmMainnet` explicitly. The venue re-checks on every
order rather than once at construction, so a long-lived venue object cannot keep
a permission that has since been revoked.

Verify before and after:

```sh
pnpm preflight | grep -A1 "Execution mode"
```

## Testnet

`MERIDIAN_EXECUTION=testnet` with a testnet credential reaches a real exchange
against simulated balances. `isLive` stays **false** — it means "real money",
not "real exchange", and the distinction is rendered in the UI and must not
blur.

Testnet is the right rung between paper and live: it exercises signing,
rate limits, order rejection, partial fills and reconnection, none of which the
simulated venue can teach you, without any money at stake.

## The ladder

No strategy skips a rung (`DESIGN.md` principle 6).

```
shadow  →  paper  →  testnet  →  live small  →  live
```

Capital additionally sits behind the tier ladder in `lib/calc/tiers.ts`:
promotion needs NAV to hold above a threshold for seven consecutive days, so a
lucky spike cannot unlock leverage. Demotion is immediate on breach — protecting
capital should not wait for confirmation.

## Reading the mode

The header chip reads two independent signals and shows the louder of them:

- **mode** — what the engine would do with an order right now;
- **nature** — what the capital ledger says has actually been deposited.

They can disagree, and when they do that is the interesting case rather than an
error. A paper engine with real capital means money sitting idle. A live engine
with simulated capital means the next deposit goes straight to a venue.

When either says real money is involved, a hairline is painted across the top of
the viewport as well — so a screenshot taken from any screen carries the fact.
