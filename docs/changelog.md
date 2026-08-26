# Changelog — the deployment-readiness pass, 2026-08-26

What changed between the merge landing and the first machine it will run on,
and why. Grouped by what it protects rather than by file.

## Bugs that could have cost money

**The stake plan rounded stakes the wrong way.** `naturalizeStakes` — which
rounds, checks the worst branch, repairs the losing leg and falls back — existed
and was ported, and the panel that needed it was doing its own
`Math.round(s/10)*10` instead. Naive rounding moves each stake by up to R5, and
on a thin book at the wrong odds the worst branch loses more than the edge was
worth. A property sweep found a book the detector correctly reported as
profitable whose placeable version lost R8. The panel now uses the repairing
version and says when no round-number plan survives.

**The kill switch stopped one desk.** The Asset loop reads halt state the
killswitch package owns; the Python events engine reads a flag in its own
schema and cannot see a Node process's state file. HALT turned the chip red,
stopped one desk, and left the other scanning and alerting. `trip()` and
`clear()` now reach both and report per desk — including "could not be reached",
because "applied" there would be a lie an operator acts on.

**Two connection pools, two environment variables, one database.** The desks
resolved `DATABASE_URL` and `DB_URL` separately, so a box with only the second
set had them pointed at different databases while both reported healthy. And the
Asset desk's default still named the pre-merge database, so a clean Compose
bring-up pointed at one that does not exist.

**Only the console read `.env.local`.** Next.js loads it automatically; nothing
else did. The trading loop, recorder, kill switch and preflight all ran on
defaults from the same directory at the same time as a console reading the
operator's real configuration.

## Correctness that was quietly wrong

**Four React bugs the merge carried across.** `Date.now()` in two render bodies
(impure — server and first client render disagree, and derived ages never
update); a board that held the open stake plan as a copy and used two effects to
keep it in step, costing a render pass per feed tick and racing on load; a panel
that reset its inputs in an effect, so there was a frame showing the previous
row's stake against the new row's odds; and a hook returning a ref read during
render, handing consumers a value that changed without re-rendering.

**The pass pipeline was typed to the simulated venue.** It only ever calls
`submit()`, but the concrete type meant a live venue could not have flowed
through it — the live path would have failed to compile at the exact moment
someone wanted it to work. Paper mode's whole claim is that the same code runs
against a real venue unchanged, and the types were contradicting it.

**A panel header could overlap its own control below 420px.** Found by measuring
horizontal overflow at six viewports rather than by looking.

## Safety made explicit rather than accidental

**One seam decides which money is at risk.** The loop used to build its venue
inline. `resolveVenue()` now decides, fails closed at every step, and returns a
written reason on every path — so "why is this on paper?" reads an answer rather
than being inferred. Seven tests, each a way to reach real money that must not
work.

**The mode is on every screen.** Read from two independent signals — what the
engine would do with an order, and what the ledger says was deposited — showing
the louder. When either means real money, a hairline is painted across the top
of the viewport, so a screenshot from any screen carries the fact.

**Preflight.** Eighteen checks that try each dependency rather than reading
configuration, each naming the consequence of its own failure. It never writes
anything.

## Visual

**Empty states became messages.** Most of this interface spends most of its time
with nothing in it, and those are correct states of a system that only acts on
evidence. Four reasons a panel can be empty now render differently — nothing to
show, still loading, not built, broken — because the first and the last demand
opposite responses.

**Skeletons are shaped like the thing that is coming**, so the layout does not
jump when data lands.

**Motion has four durations and two curves**, chosen against what the motion is
for. Depth comes from inside-lit surfaces rather than shadows.

**Page padding moved into `<main>` once.** Thirteen screens each declared their
own and the six event-desk screens declared none, which is why that desk sat
flush against the rail.

**`/gallery`** renders every primitive in every state. Not in the navigation —
it is a workbench for the states that cannot be reached on demand.

## Tests

474 vitest (up from 451), 73 event-desk checks, 137 pytest. New: eleven property
tests for the arbitrage identities, seven for the execution seam, three for the
kill switch spanning both desks, two for the fee model generalising across
venues.

The parity harness now understands the `@/` alias, so a module can be tested
there without avoiding the import style the rest of the codebase uses.

## Documentation

`docs/` with an index, architecture, quickstart, operations runbook,
configuration, paper-and-live, the model, six strategy pages, a deployment
checklist, and the August research note. `.env.example` documents all 32
variables with what happens when each is missing *and* when it is wrong.
