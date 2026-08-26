# Meridian documentation

Meridian is one firm running two desks against one book. Some venues price
**assets** — perpetual futures, currency pairs. Others price **events** — match
outcomes, prediction-market contracts. The discipline is identical on both:
measure honestly, cost pessimistically, size by evidence, grade yourself after.

Start here depending on why you are here.

## I need it running

| | |
|---|---|
| [Quick start](./quickstart.md) | Fresh machine to a running console |
| [Configuration](./configuration.md) | Every variable, and what breaks without it |
| [Operations](./operations.md) | Start, stop, monitor, recover. What each screen means |
| [Deployment checklist](./deployment-checklist.md) | The tick-through for a first live bring-up |

## I need to understand it

| | |
|---|---|
| [Architecture](./architecture.md) | The processes, the data flow, the seams |
| [Paper and live](./paper-and-live.md) | How paper mirrors live, and how to promote |
| [The model](./model.md) | What it decides, what it cannot do, how to read its log |
| [Strategies](./strategies/) | One document per edge, on both desks |

## I need to change it

| | |
|---|---|
| [`DESIGN.md`](../DESIGN.md) | Architecture and the seven non-negotiable principles |
| [`GOVERNANCE.md`](../GOVERNANCE.md) | The multi-portfolio charter: caps, isolation, promotion |
| [`ROADMAP.md`](../ROADMAP.md) | Done, in flight, next — with dated findings |
| [`OPPORTUNITIES.md`](../OPPORTUNITIES.md) | The living ledger. Read it first; update it last |
| [Changelog](./changelog.md) | What changed and why |

## The three things worth knowing before anything else

**Nothing here trades real money yet, and that is enforced in code.** Paper is
the default and has to be opted out of, twice, on the machine that would trade.
See [paper and live](./paper-and-live.md).

**An empty screen is usually a measurement.** Most of this interface spends most
of its time with nothing in it, because both desks only act when the evidence
says to. "No arbitrage open" and "nothing is scanning" are drawn differently on
purpose — one is a finding, the other is a fault.

**The ledger in `OPPORTUNITIES.md` is the memory.** Verdicts are dated and a
REJECTED one is not re-argued without new evidence. It is the reason this system
does not rebuild the same losing idea every quarter.
