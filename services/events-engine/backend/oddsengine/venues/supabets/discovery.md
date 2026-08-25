# Supabets — endpoint discovery notes

**Status:** vendor CONFIRMED (WA.Technology), endpoints UNCONFIRMED — skeleton, disabled.

## Research findings (spec §14.2)
- Platform: **WA.Technology** (WA.Sports on WA.Platform). Source: WA.Technology / iGB.
- Data supplier: OpticOdds.
- WA.Platform frontends have recognizable SPA/JSON patterns in DevTools — expect a
  clean JSON odds feed once the host is captured.

## Discovery procedure
Spec §3.2 HAR procedure from an SA-resident IP (see betway/discovery.md). Note any
WA.Technology-branded API hosts in the HAR; record refresh cadence and auth headers.

## Captured endpoints (fill in)
- events_url: TBD
- odds_url: TBD
- ws_url: TBD
- headers: TBD
