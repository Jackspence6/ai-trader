# Sunbet — endpoint discovery

**Status: RESOLVED.** Captured live on 2026-08-25 from a South African IP
(Chrome DevTools network log on the public sportsbook). `enabled: true`.

## What was found

| | |
|---|---|
| Platform | **Kambi** — confirmed on the wire, not just from press releases |
| Front end | **Shape Games** (`*.shapegamescloud.com`), which is why the platform is invisible from the page source |
| Kambi base | `https://eu.offering-api.kambicdn.com` |
| Operator code | `siwc` |
| Auth params | `channel_id=1&client_id=200&lang=en_ZA&market=ZA` (no token, no cookie) |
| Deep link | `https://www.sunbet.co.za/en/sports#/event/{event_id}` |

```
listView   {base}/offering/v2018/siwc/listView/{path}.json?{params}&useCombined=true&useCombinedLive=true
betoffer   {base}/offering/v2018/siwc/betoffer/event/{event_id}.json?{params}
```

`{path}` is a Kambi term path — a sport (`football`, `tennis`, `basketball`,
`american_football`, `cricket`, `rugby_union`, `table_tennis`, `baseball`,
`ice_hockey`, `esports`, `golf`) or a league (`football/south_africa/psl`).
`mixed_martial_arts` 404s — Sunbet does not carry it.

## How it was found

The obvious guesses all missed. `sunbet.co.za/sport` and `/en/sport/...` return the
site's error page; the nav link is `/en/sports`, and that page renders skeleton
loaders for ~20 seconds before the sportsbook mounts. Nothing matching `offering`
appears in the network log until then. The first non-analytics requests are to
`control-panel.*.shapegamescloud.com/siwc/api/...` — which is what makes it look
like a Shape Games book rather than a Kambi one. The Kambi calls only start once
the league highlight tiles hydrate, and the operator code `siwc` is the same string
Shape Games uses in its own path segment.

## Book size at capture

259 football events (245 pre-match), 244 tennis (209 pre-match), 183 American
football, 57 table tennis, 41 esports, 36 ice hockey, 23 cricket, 19 basketball,
18 rugby union, 17 golf, 16 baseball. A PSL fixture carried 111 bet offers.

## Wire formats

* odds — milli-decimal integers: `1960` → 1.96 (matched the page render)
* lines — milli, signed: `2500` → 2.5, `-500` → -0.5
* `event.state` — `NOT_STARTED` | `STARTED` | `FINISHED`; the sport-level listView
  mixes live and pre-match, so callers filter on it
* outcome `status` — `OPEN` | `SUSPENDED`; suspended sides are dropped, not priced

## The part that actually matters: market mapping

A Kambi event carries ~110 bet offers, and the lookalikes are dangerous. All of
these were live on one PSL fixture:

```
type 6 "Over/Under"  Total Goals                    lifetime FULL_TIME  occ GOALS
type 6 "Over/Under"  Total Corners                  lifetime FULL_TIME  occ (null)
type 6 "Over/Under"  Total Goals by Chippa United   lifetime FULL_TIME  occ (null)
type 6 "Over/Under"  Total Goals - 1st Half         lifetime (null)     occ GOALS
```

Mapping on `betOfferType` alone collapses corners, team totals and half totals onto
the match total — at the same line, so they would look like the same market and
produce phantom arbs. Requiring `lifetime == FULL_TIME` still lets corners and team
totals through, *and* wrongly rejects the genuine full-match "Both Teams To Score",
which carries a null lifetime.

`venues/kambi.py` therefore gates on the exact triple
`(sport, betOfferType.id, criterion.englishLabel)` plus the recorded
lifetime / occurrenceType / outcome-type set. Everything else is kept as an
unmapped raw market — visible, never priced. Adding a market means observing it
first and adding a row.

Coverage of that allowlist against the live book (8 pre-match events per sport):
115 of 288 football offers mapped, every event with its 1X2, totals, handicaps and
BTTS; 18 of 49 tennis offers, every event with its match odds.

## Settlement rules the payload gives us for free

Kambi states the settlement basis in the criterion label, so the rules profile is
derived rather than hand-maintained:

* soccer — `Full Time` / lifetime `FULL_TIME` → `soccer_duration = REG_90`
* basketball — only `Moneyline - Including Overtime` exists → `basketball_ot = INCLUDED`
* rugby — `Regular Time` **and** `Including Overtime` are separate offers on the same
  event; only the regular-time trio is mapped, so the two can never be paired
* tennis — retirement handling is in Sunbet's T&Cs, not the payload, so
  `tennis_retirement` stays `UNVERIFIED` and tennis legs are always rule-risk

## Conduct

Public odds endpoints only. No login, account, bet-placement or balance calls were
touched. Requests are paced at 15 s with jitter (`min_interval_s`), one believable
UA, no CAPTCHA interaction.
