# OddsEngine — operator runbook

## 1. Endpoint discovery procedure (per SA book — mandatory, spec §3.2)

No commercial odds feed covers SA-licensed books (The Odds API has no SA region;
OddsJam is US/CA). Each book is scraped from its own frontend, discovered like this:

1. From an **SA-resident IP**, open the book's sportsbook plus one in-play event in Chrome.
2. DevTools → Network → filter **XHR/Fetch/WS**. Browse prematch soccer, tennis, and the live event.
3. **Export a HAR** of the session (Network panel → ⬇). Keep it out of git (`*.har` ignored).
4. **Let the analyser find the odds feed for you** — this is the step that used to mean
   squinting at DevTools:

   ```bash
   python -m oddsengine.discovery capture.har --venue betway_sa
   ```

   It scores every JSON response for how much it looks like an odds feed (decimal-odds-shaped
   numbers, selection/market/betOffer structures, team and kickoff fields), ignores analytics
   and asset noise, collapses repeated polling of one endpoint, surfaces WebSocket price
   streams, flags endpoints that need auth headers **without printing their values**, and
   prints a ready-to-paste `config/venues.yaml` block plus a payload-shape sketch to write
   `parse_odds` against. Add `--json` for machine-readable output.

   If it reports nothing, the capture is the problem, not the book — usually 'Preserve log'
   was off, or odds hadn't loaded yet. It never guesses an endpoint that wasn't in your capture.
5. Record the findings in the venue's `backend/oddsengine/venues/<book>/discovery.md`.
6. Fill `config/venues.yaml → venues.<book>.endpoints`, implement `parse_events` /
   `parse_odds` against the captured payloads, add a fixture test, flip `enabled: true`.
7. Watch `/venues/health` for a day before trusting it in detection.

**Sunbet is done** (2026-08-25): Kambi, base `https://eu.offering-api.kambicdn.com`,
operator `siwc`, params `channel_id=1&client_id=200&lang=en_ZA&market=ZA`. It is enabled in
`config/venues.yaml` and live. Two things about that capture are worth carrying to the
other books. First, the sportsbook is a **Shape Games** front end that renders skeleton
loaders for ~20 seconds before mounting; the Kambi calls only appear after the league
tiles hydrate, so a capture that stops early looks like a book with no API. Second, and
more important: getting the endpoint is the easy half. A Kambi event carries ~110 bet
offers, and "Total Corners", "Total Goals by <team>" and "Total Goals - 1st Half" all
share a betOfferType with the match total. Mapping on type — or on a substring of the
label — quietly merges them and manufactures arbs that do not exist.
`venues/kambi.py` gates on the exact `(sport, betOfferType.id, criterion.englishLabel)`
triple plus the recorded lifetime, occurrenceType and outcome-type set; everything else
is carried unmapped and never priced. Expect to do the same work per book.
See `venues/sunbet/discovery.md` for the full record.

**Betway SA is done** (2026-08-25): a Betradar feed proxied through Betway's own
origin at `www.betway.co.za/sportsapi/br/v1/BetBook/Highlights/`, one request per sport
returning the whole board as flat events/markets/outcomes/prices arrays, no auth.
Enabled in `config/venues.yaml`. Three lessons from that capture:
DevTools alone missed it (the app fires its odds calls before any listener attaches, and
hooking `window.fetch` afterwards catches nothing) — `performance.getEntriesByType('resource')`
in the console is the reliable read. The `marketTypes` query parameter is mandatory;
omit it and the response has no `events` key at all. And the settlement scope lives in
`additionalInfo.ProviderMarketGroups`, not the market name: the 1st-half total has the
same `marketTypeCName` and the same display name as the match total, and only the
`regular_play` tag separates them. Betway also publishes a totals ladder as one squashed
parent carrying every line's outcomes, with empty per-line shells alongside — skip the
parent and you lose totals, price it whole and you invent an arb between Over 0.5 and
Under 5.5. See `venues/betway/discovery.md`.

Per-book head starts: **Supabets** is
WA.Technology (clean SPA JSON expected). **Hollywoodbets** is in-house with confirmed
Cloudflare + reCAPTCHA — plan on the Playwright network-tap
(`venues/skeleton.py::playwright_network_tap`), min interval ≥30s, and back off on any
challenge; no CAPTCHA circumvention, ever. **Betway SA** is in-house — assume a WAF.

Conduct rules (all books): public odds pages only; never login/account endpoints;
per-venue min request interval with jitter; SA egress IP; rotate only if rate-limited,
modestly. If a book hard-blocks, slow down or drop it — don't escalate.

## 2. Telegram setup (spec §6)

1. @BotFather → `/newbot` → copy the token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Create a private channel for alerts, add the bot as admin.
3. Get the channel id (forward a message to @userinfobot, or call `getUpdates`) →
   `TELEGRAM_CHANNEL_ID`. Optionally a second ops channel → `TELEGRAM_OPS_CHANNEL_ID`.
4. Set `ODDSENGINE_DRY_RUN=false` to actually send. Until then alerts are logged.
5. Inline buttons: **Placed / Missed / Void** feed the capture-rate + realized-vs-theoretical
   tracking; **Calc** deep-links into the dashboard's stake calculator (`/?opp=<id>`).

## 3. Circuit breakers & health (spec §7)

- Adapters self-report; 5 consecutive errors ⇒ **quarantined**, staleness > 3× interval ⇒
  **stale**. The engine excludes quarantined/stale venues' quotes from detection.
- Ops alerts post to the ops channel on state transitions (10-min cooldown per venue).
- **Kill switch**: dashboard Settings → Engage (or `POST /killswitch`, or
  `ODDSENGINE_KILL_SWITCH=true`). Alerts stop; measurement continues so the dry-run
  dataset stays intact.

## 4. Dry run → go/no-go (spec §6, M6)

- Run the stack for 14 days. Everything is measured whether or not anyone acts.
- `python -m oddsengine.report <export.json> --out report.md` renders the decision:
  **≥3 usable arbs/day @ ≥1% margin @ ≥R2,000/leg**, window-duration distribution,
  capture rate, realized vs theoretical.
- Mid-run sanity: dashboard → Analytics (same numbers, live).

## 5. Compliance notes (factual, not legal advice — spec §11)

- SA bookmakers are provincially licensed (WCGRB, Mpumalanga Economic Regulator, etc.);
  FICA/KYC applies before withdrawals.
- SARS: casual winnings are generally untaxed, but **systematic arbitrage income may be
  treated as taxable** — get professional tax advice before scaling.
- Polymarket from SA (as of the spec's research, mid-2026): accessible, no geoblock, no
  current prohibition; FSCA has not authorized it, the NGB has not claimed jurisdiction,
  and SABA (policy paper, 27 Jul 2026) is lobbying to restrict prediction markets.
  Status can change — re-check before relying on it. Funding is USDC via local
  exchanges (VALR/Luno); SARS treats crypto as property and CARF reporting visibility
  is increasing from 2026.
- **One account per person.** Promos are one-per-person/household/IP. Phase 2's schema
  enforces one account per person per venue. Nothing in this system may be used for
  multi-accounting or borrowed accounts.

## 6. Ops quick reference

| Task | Command |
|---|---|
| Full stack up / down | `make up` / `make down` |
| Tail the hot path | `make logs` |
| Re-run migrations | `make migrate` |
| Local sim + dashboard | `make dev` + `make dashboard-dev` |
| Record raw feeds | attach `replay.Recorder` (see `replay/harness.py`) |
| Replay a capture | `python -m oddsengine.replay.harness runs/capture.jsonl --speed 10` |
| Fee sanity check | `pytest tests/test_fees.py -q` |
