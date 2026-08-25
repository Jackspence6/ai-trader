# Betway SA — endpoint discovery

**Status: RESOLVED (with a caveat).** Captured live on 2026-08-25 from a South
African IP, in a real browser on the public sportsbook. `enabled: true`.

## What was found

Betway proxies a **Betradar** feed through its own origin, so there is no separate
API host to find — the calls sit under `/sportsapi/` on the main domain:

```
GET https://www.betway.co.za/sportsapi/br/v1/BetBook/Highlights/
    ?countryCode=ZA&sportId={sport}&Skip=0&Take={n}&cultureCode=en-US
    &isEsport=false&boostedOnly=false
    &marketTypes=...&marketTypes=...          (repeated)

GET https://www.betway.co.za/sportsapi/br/v1/Feeds/RegionsAndLeagues/{sport}?countryCode=ZA
GET https://config.betwayafrica.com/cron/sports-book/market-header-config/synapse/ZA
```

**`marketTypes` is mandatory.** Drop it and the response has no `events` key at
all — not an empty list, no key. The accepted names differ per sport and come from
the market-header config above: soccer uses `[Win/Draw/Win]`, `Total Goals`,
`[Both Teams To Score]`; tennis uses `[Match Winner]`, `Total Games`; rugby union
uses `[Win/Draw/Win]`. `sportId` values are slugs — `soccer`, `tennis`,
`rugby-union`, `basketball`, `american-football`, `table-tennis`, `cricket`.

The response is relational, not nested — four flat arrays joined on ids:

```
events[]    eventId, name, homeTeam, awayTeam, league, region,
            expectedStartEpoch (unix seconds), isLive, isOutright, isFinished
markets[]   marketId, eventId, marketTypeCName, name, handicap (plain decimal),
            isActive / isSuspended / shouldDisplay / isSquashedParent,
            additionalInfo.ProviderMarketGroups  (a JSON *string*, not a list)
outcomes[]  outcomeId, marketId, name, handicap, originalMarketId, isTradingActive
prices[]    outcomeId, priceDecimal, numerator, denominator
```

Odds are plain decimals (`1.92`), unlike Kambi's milli integers. At capture: 59
soccer events, 98 tennis, 32 rugby union in one page.

## How it was found

DevTools network alone was not enough — the page fires its odds requests before a
network listener attaches, and hooking `window.fetch` afterwards catches nothing
because the app already holds its own reference. `performance.getEntriesByType('resource')`
is the reliable read: it lists everything the page has fetched since load,
including calls made before any instrumentation.

## The two things that would have silently broken this

**1. Provider market groups, not market names, carry the settlement scope.**
Betradar tags each market `["all","score","regular_play"]` for a full match, and
with a period tag for the halves. The 1st-half total has the *same*
`marketTypeCName` and the same display name as the match total — only the group
differs. So the gate is: `(sport, marketTypeCName)` on the allowlist **and**
`regular_play` present. A market that stops declaring `regular_play` stops being
priced, without anyone having to spot a new label.

**2. The totals ladder is one market, not many.** It is published as a squashed
parent (`isSquashedParent: true`, `handicap: 0`) carrying *every* line's outcomes —
22 of them on one soccer event, Over/Under 0.5 through 5.5. The per-line child
markets are listed as well, but they are empty shells with no outcomes attached.
Skipping the parent drops totals entirely; pricing it whole puts eleven lines in
one book and reads as a huge arb between Over 0.5 at 1.02 and Under 5.5. Each
outcome carries its own `handicap` and an `originalMarketId` naming its line, so
the adapter splits the parent on that and emits one market per line.

## Caveat: Akamai

`www.betway.co.za` runs Akamai bot management — the sensor beacon
(`info.betway.co.za/{random}?...&je=...`) fires on every page load. The endpoint
itself needs no auth and answers with cookies omitted, but this capture was made
in a real browser, so **server-side reachability is unproven**. If the adapter
quarantines on 403s, that is the WAF. The answer is the Playwright network tap in
`venues/skeleton.py` (a real browser context on public odds pages, paced), or
dropping the book. Not evasion, and never a CAPTCHA.

## Conduct

Public odds endpoints only. No login, account, balance or bet-placement call was
touched. 20 s pacing with jitter, one believable UA.
