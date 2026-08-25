// Mirrors backend/oddsengine/models.py JSON shapes.

export interface Leg {
  venue_id: string;
  venue_name: string;
  outcome: string;
  selection_label: string;
  odds: number;
  raw_price: number | null;
  fee_rate: number | null;
  stake_zar: number;
  deep_link: string;
  rules_group: string;
  is_pm: boolean;
  token_id: string | null;
  max_stake_zar: number | null;
  order_index: number;
}

export interface Opportunity {
  id: string;
  opp_type: "bookie_vs_bookie" | "bookie_vs_polymarket" | "polymarket_internal" | "promo_boost" | "promo_rollover";
  event_id: string;
  event_label: string;
  sport: string;
  league: string | null;
  start_time: string | null;
  market_key: string;
  legs: Leg[];
  margin_pct: number;
  total_stake_zar: number;
  guaranteed_profit_zar: number;
  roi_pct: number;
  executable_zar_per_leg: number;
  stakes_natural: boolean;
  score: number;
  score_breakdown: Record<string, number>;
  urgency: "low" | "medium" | "high" | "critical";
  timing: "pre_match" | "near_kickoff" | "live";
  rule_risk: boolean;
  rule_risk_note: string | null;
  mirrored: boolean;
  fx_rate: number | null;
  first_seen: string;
  last_seen: string;
  peak_margin_pct: number;
  state: "active" | "expired";
  window_s: number | null;
  notes: string[];
}

export interface VenueHealth {
  venue_id: string;
  state: "ok" | "degraded" | "stale" | "quarantined" | "unconfigured";
  last_success: string | null;
  error_rate: number;
  consecutive_errors: number;
  staleness_s: number | null;
  note: string | null;
  ts: string;
}

export interface AnalyticsSummary {
  days_observed: number;
  opportunities_total: number;
  usable_total: number;
  usable_per_day: number;
  target_per_day: number;
  dry_run_days_target: number;
  go_no_go: "GO" | "NO-GO" | "PENDING";
  margin_pct: Quantiles;
  margin_histogram: Bucket[];
  window_s: Quantiles;
  window_histogram: Bucket[];
  executable_zar: Quantiles;
  capture_rate: number;
  theoretical_profit_zar: number;
  realized_profit_zar: number;
  by_type: Record<string, number>;
  by_day: Record<string, number>;
  placements: Record<string, number>;
}

export interface Quantiles { p25: number; p50: number; p75: number; p95: number }
export interface Bucket { bucket: string; count: number }

/** How the board is getting its data right now.
 *  "down" is a real state and must look like one — see lib/events/useFeed. */
export type FeedStatus = "connecting" | "live" | "demo" | "down";
