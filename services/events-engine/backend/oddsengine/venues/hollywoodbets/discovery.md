# Hollywoodbets — endpoint discovery notes

**Status:** UNCONFIRMED endpoints — skeleton adapter, disabled.

## Research findings (spec §14.2)
- Platform: in-house "BET Software" / "SyX" (Elixir/Erlang). Sources: betsoftware.com,
  erlang-solutions case material, zoominfo.
- Esports: DATA.BET iFrame (separate origin — treat as its own mini-venue if needed).
- Anti-bot: **Cloudflare + reCAPTCHA CONFIRMED.** Plan for the Playwright fallback:
  real Chromium context, public odds pages only, min interval ≥ 30s, no CAPTCHA
  circumvention — if a page hard-blocks, back off; do not escalate.

## Discovery procedure
Same HAR procedure as spec §3.2 (see betway/discovery.md), from an SA-resident IP.
For the SPA: watch which XHR/WS responses actually carry odds JSON while browsing a
soccer event; record the URL regex for `endpoints.xhr_pattern` so
`fetch_odds_via_browser` can network-tap it.

## Captured endpoints (fill in)
- events_url: TBD
- odds_url / xhr_pattern: TBD
- ws_url: TBD
- notes on Cloudflare behavior (cookies, challenge cadence): TBD
