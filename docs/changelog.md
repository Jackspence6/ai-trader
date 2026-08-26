# Changelog — the deployment-readiness pass, 2026-08-26

What changed between the merge landing and the first machine it will run on,
and why. Grouped by what it protects rather than by file.

## Bugs that would have shown up on the deployment machine

**A failed poll waited a full interval before trying again.** Every screen polls
while the login page is showing, and every one of those polls is refused —
correctly, the site is locked. `useLive` then waited the endpoint's whole
interval before retrying. For `/api/execution`, which polls at 60 seconds, that
meant the badge answering "is real money at risk?" stayed on its placeholder
for up to a minute after signing in, which is the one moment anybody reads it;
venue health was blank for the same reason. Failures now back off from 1.5s,
doubling, capped at the endpoint's own cadence — quick recovery, never faster
than the endpoint asked for, and an endpoint that stays dead settles at exactly
the rate it would have had anyway. Found by running the deployment bundle the
way the deployment machine will: no database, nothing else up.

**The console had been rendering in the wrong typeface since the first commit
of this pass.** `next/font/google` fetches font files at build time, this box
has no route to `fonts.gstatic.com`, and the workaround was a swap script:
copy `fonts.ts` aside, write a system-font module over it, build, copy back.
The copy-back is the last step, so a build that does not reach its last step
leaves the repository in the offline state — and then `git add -A` committed
both the swapped file and the backup holding the real one. Nothing failed and
nothing looked broken; a console in Helvetica still looks like a console. Inter
and JetBrains Mono are now vendored (88KB, latin subset, variable axis, SIL OFL
included) and loaded through `next/font/local`. No font path touches the
network, there is no swap and no state, and two builds of one commit cannot
differ.

**`pnpm test:all` was a statement about the build container, not the
deployment box.** The engine third invoked bare `python`, which macOS has not
shipped since Monterey; the engine's packages were never installed on the host,
because the engine runs in Docker; and pytest run from the wrong directory
misses the `pyproject.toml` holding `asyncio_mode`, silently dropping four
async tests from 137 to 133. `scripts/py.mjs` resolves all three explicitly and
names which one it hit when it cannot. It never reports success without
running.

**The Python tree was unpinned.** `pyproject.toml` states floors; the Node side
has a lockfile and the Python side had nothing, so the deployment box could
resolve a tree the 137 engine tests had never run against.
`constraints.txt` pins the tested set and is used by both the host venv and the
engine image.

**The lockfile was broken.** `pnpm install --frozen-lockfile` — the first thing
bootstrap runs, and the first thing that happens on a fresh clone — refused it:
an entry named but not resolved. A lockfile that is subtly wrong installs fine
under a plain `pnpm install` and only fails under `--frozen-lockfile`, so this
would have surfaced on the deployment morning rather than here.

**One gitignore instead of two.** The merge kept the arbitrage repo's and
dropped the trader's. Each covered something the other did not, and the gap
mattered on a Mac: no `.DS_Store` rule, and no `*.pem` rule to stop a stray key
being one `git add .` away from a commit.

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

**The elevation tokens were defined and never used.** `--lift-1`, `--lift-2`,
`--glow-accent`, `--glow-up` and `--glow-down` had shipped with a comment
explaining that a dark instrument is lit from inside rather than by shadow, and
nothing referenced any of them — which is why the interface read as correct and
inert at once. A `surface` utility now gives every panel a lit top edge and a
gradient that is lighter at the top than the bottom; the body carries an
ambient wash from two directions; three `bloom-*` utilities put a directional
glow behind large figures, gated on the figure being non-zero, because a
glowing zero claims something is happening when nothing is. The wash sits on
`body::before`, not `::after`: both are children of `body`, so `::after` paints
over every panel and glyph on the screen. Nothing added sits over text, so no
measured contrast changed.

## Tests

478 vitest (up from 451), 73 event-desk checks, 137 pytest. New: eleven property
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
