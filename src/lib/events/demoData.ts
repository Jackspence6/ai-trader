// Demo-mode data: the spec §14.1 worked examples as live-looking rows, random-walked
// so the terminal breathes even with no backend attached.

import type { AnalyticsSummary, Opportunity, VenueHealth } from "./types";

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString();

function opp(partial: Partial<Opportunity> & Pick<Opportunity, "id" | "event_label" | "market_key">): Opportunity {
  return {
    opp_type: "bookie_vs_bookie", event_id: partial.id + "-e", sport: "soccer", league: null,
    start_time: iso(180), legs: [], margin_pct: 2, total_stake_zar: 10000,
    guaranteed_profit_zar: 300, roi_pct: 3, executable_zar_per_leg: 10000,
    stakes_natural: true, score: 70, score_breakdown: {
      margin: 0.66, executable_size: 1, window_duration: 0.9, venue_softness: 0.6,
      rule_risk: 1, account_safety: 1, fx_risk: 1, resolution_risk: 1, staleness_factor: 1,
    },
    urgency: "medium", timing: "pre_match", rule_risk: false, rule_risk_note: null,
    mirrored: false, fx_rate: null, first_seen: iso(-3), last_seen: iso(0),
    peak_margin_pct: 3.5, state: "active", window_s: null, notes: [],
    ...partial,
  } as Opportunity;
}

export const DEMO_OPPS: Opportunity[] = [
  opp({
    id: "5892bc5fc624", event_label: "Mamelodi Sundowns vs Orlando Pirates",
    league: "Betway Premiership", market_key: "1X2|", margin_pct: 3.45, score: 86.5,
    guaranteed_profit_zar: 320, executable_zar_per_leg: 12632,
    legs: [
      { venue_id: "betmock_a", venue_name: "MockBet Alpha", outcome: "HOME", selection_label: "Mamelodi Sundowns", odds: 2.4, raw_price: null, fee_rate: null, stake_zar: 4300, deep_link: "#", rules_group: "REG_90", is_pm: false, token_id: null, max_stake_zar: 20000, order_index: 1 },
      { venue_id: "betmock_b", venue_name: "MockBet Bravo", outcome: "DRAW", selection_label: "Draw", odds: 3.8, raw_price: null, fee_rate: null, stake_zar: 2750, deep_link: "#", rules_group: "REG_90", is_pm: false, token_id: null, max_stake_zar: 20000, order_index: 2 },
      { venue_id: "betmock_c", venue_name: "MockBet Charlie", outcome: "AWAY", selection_label: "Orlando Pirates", odds: 3.5, raw_price: null, fee_rate: null, stake_zar: 2950, deep_link: "#", rules_group: "REG_90", is_pm: false, token_id: null, max_stake_zar: 20000, order_index: 3 },
    ],
  }),
  opp({
    id: "dbeae2be99d7", event_label: "Kasatkina vs Fernandez", sport: "tennis", league: "WTA",
    market_key: "MONEYLINE_2WAY|", margin_pct: 3.84, score: 89.5, urgency: "medium",
    guaranteed_profit_zar: 395, executable_zar_per_leg: 19619, start_time: iso(120),
    legs: [
      { venue_id: "betmock_a", venue_name: "MockBet Alpha", outcome: "HOME", selection_label: "Kasatkina", odds: 2.1, raw_price: null, fee_rate: null, stake_zar: 4950, deep_link: "#", rules_group: "BALL_SERVED", is_pm: false, token_id: null, max_stake_zar: 20000, order_index: 1 },
      { venue_id: "betmock_b", venue_name: "MockBet Bravo", outcome: "AWAY", selection_label: "Fernandez", odds: 2.06, raw_price: null, fee_rate: null, stake_zar: 5050, deep_link: "#", rules_group: "BALL_SERVED", is_pm: false, token_id: null, max_stake_zar: 20000, order_index: 2 },
    ],
  }),
  opp({
    id: "30da96ec652e", event_label: "Los Angeles Lakers vs Boston Celtics", sport: "basketball",
    league: "NBA", market_key: "MONEYLINE_2WAY|", opp_type: "bookie_vs_polymarket",
    margin_pct: 1.13, score: 51, urgency: "high", timing: "near_kickoff", rule_risk: true,
    rule_risk_note: "rules unverified (PER_MARKET vs INCLUDED)", fx_rate: 17.65,
    guaranteed_profit_zar: 20, total_stake_zar: 2500, executable_zar_per_leg: 15000,
    start_time: iso(45),
    score_breakdown: {
      margin: 0.23, executable_size: 1, window_duration: 0.4, venue_softness: 0.42,
      rule_risk: 0.25, account_safety: 1, fx_risk: 0.7, resolution_risk: 0.6, staleness_factor: 1,
    },
    notes: ["If the PM leg fills late: sell the acquired side to unwind.", "FX buffered @ 17.65 USDZAR."],
    legs: [
      { venue_id: "betmock_a", venue_name: "MockBet Alpha", outcome: "AWAY", selection_label: "Celtics", odds: 2.1, raw_price: null, fee_rate: null, stake_zar: 1200, deep_link: "#", rules_group: "INCLUDED", is_pm: false, token_id: null, max_stake_zar: 15000, order_index: 1 },
      { venue_id: "polymarket", venue_name: "Polymarket", outcome: "HOME", selection_label: "Yes (Lakers)", odds: 1.9512, raw_price: 0.5, fee_rate: 0.05, stake_zar: 1300, deep_link: "https://polymarket.com", rules_group: "PER_MARKET", is_pm: true, token_id: "tok", max_stake_zar: 35294, order_index: 2 },
    ],
  }),
  opp({
    id: "ce63a085953d", event_label: "Next Johannesburg mayor", sport: "other", league: "Politics",
    market_key: "NEGRISK_MULTI||q:pm-jhb-mayor", opp_type: "polymarket_internal",
    margin_pct: 2.41, score: 54, urgency: "low", fx_rate: 17.65,
    guaranteed_profit_zar: 232, total_stake_zar: 9950, executable_zar_per_leg: 27212,
    start_time: iso(60 * 24 * 30),
    legs: [
      { venue_id: "polymarket", venue_name: "Polymarket", outcome: "OUT:a", selection_label: "Candidate A · Yes", odds: 3.2425, raw_price: 0.3, fee_rate: 0.04, stake_zar: 3150, deep_link: "https://polymarket.com", rules_group: "DEFAULT", is_pm: true, token_id: "t0", max_stake_zar: 27212, order_index: 1 },
      { venue_id: "polymarket", venue_name: "Polymarket", outcome: "OUT:b", selection_label: "Candidate B · Yes", odds: 3.0423, raw_price: 0.32, fee_rate: 0.04, stake_zar: 3350, deep_link: "https://polymarket.com", rules_group: "DEFAULT", is_pm: true, token_id: "t1", max_stake_zar: 27212, order_index: 2 },
      { venue_id: "polymarket", venue_name: "Polymarket", outcome: "OUT:c", selection_label: "Candidate C · Yes", odds: 2.9512, raw_price: 0.33, fee_rate: 0.04, stake_zar: 3450, deep_link: "https://polymarket.com", rules_group: "DEFAULT", is_pm: true, token_id: "t2", max_stake_zar: 27212, order_index: 3 },
    ],
  }),
];

export const DEMO_HEALTH: Record<string, VenueHealth> = {
  polymarket: { venue_id: "polymarket", state: "ok", last_success: iso(0), error_rate: 0.001, consecutive_errors: 0, staleness_s: 0.4, note: "WS market channel", ts: iso(0) },
  betmock_a: { venue_id: "betmock_a", state: "ok", last_success: iso(0), error_rate: 0.01, consecutive_errors: 0, staleness_s: 4.1, note: null, ts: iso(0) },
  betmock_b: { venue_id: "betmock_b", state: "degraded", last_success: iso(-1), error_rate: 0.34, consecutive_errors: 2, staleness_s: 41, note: "elevated error rate", ts: iso(0) },
  betway_sa: { venue_id: "betway_sa", state: "unconfigured", last_success: null, error_rate: 0, consecutive_errors: 0, staleness_s: null, note: "endpoints not discovered yet — see ops/runbook.md", ts: iso(0) },
  hollywoodbets: { venue_id: "hollywoodbets", state: "unconfigured", last_success: null, error_rate: 0, consecutive_errors: 0, staleness_s: null, note: "Cloudflare — Playwright fallback pending discovery", ts: iso(0) },
  sunbet: { venue_id: "sunbet", state: "unconfigured", last_success: null, error_rate: 0, consecutive_errors: 0, staleness_s: null, note: "Kambi operator code pending discovery", ts: iso(0) },
};

export const DEMO_ANALYTICS: AnalyticsSummary = {
  days_observed: 5, opportunities_total: 214, usable_total: 57, usable_per_day: 3.3,
  target_per_day: 3, dry_run_days_target: 14, go_no_go: "PENDING",
  margin_pct: { p25: 1.2, p50: 1.9, p75: 3.1, p95: 4.6 },
  margin_histogram: [
    { bucket: "0–0.5", count: 61 }, { bucket: "0.5–1", count: 52 }, { bucket: "1–1.5", count: 38 },
    { bucket: "1.5–2", count: 24 }, { bucket: "2–3", count: 21 }, { bucket: "3–5", count: 14 },
    { bucket: "5–8", count: 4 }, { bucket: "8+", count: 0 },
  ],
  window_s: { p25: 11, p50: 46, p75: 210, p95: 540 },
  window_histogram: [
    { bucket: "0–5", count: 42 }, { bucket: "5–15", count: 35 }, { bucket: "15–30", count: 30 },
    { bucket: "30–60", count: 34 }, { bucket: "60–120", count: 28 }, { bucket: "120–300", count: 25 },
    { bucket: "300–600", count: 14 }, { bucket: "600+", count: 6 },
  ],
  executable_zar: { p25: 2400, p50: 6100, p75: 12500, p95: 22000 },
  capture_rate: 0.42,
  theoretical_profit_zar: 18420, realized_profit_zar: 7690,
  by_type: { bookie_vs_bookie: 31, bookie_vs_polymarket: 17, polymarket_internal: 9 },
  by_day: { "2026-08-21": 4, "2026-08-22": 2, "2026-08-23": 5, "2026-08-24": 3, "2026-08-25": 3 },
  placements: { placed: 24, missed: 27, voided: 4, partial: 2 },
};

/** Random-walk a copy of the demo opportunities so the board flashes like a live feed. */
export function walkDemo(opps: Opportunity[]): Opportunity[] {
  return opps.map((o) => {
    const drift = (Math.random() - 0.47) * 0.12;
    const margin = Math.max(0.2, +(o.margin_pct + drift).toFixed(2));
    return {
      ...o,
      margin_pct: margin,
      peak_margin_pct: Math.max(o.peak_margin_pct, margin),
      score: Math.max(5, Math.min(99, +(o.score + drift * 6).toFixed(1))),
      guaranteed_profit_zar: Math.max(0, Math.round(o.total_stake_zar * margin * 0.0095)),
      last_seen: new Date().toISOString(),
    };
  });
}
