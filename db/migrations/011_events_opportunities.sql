-- Event Markets desk. Namespaced into its own schema so the two desks
-- can never collide on a generic table name like markets or events.
CREATE SCHEMA IF NOT EXISTS events;
SET search_path TO events, public;

-- 002: opportunities, lifecycles, alerts, placements (Phase 1, spec §8)

CREATE TABLE IF NOT EXISTS opportunities (
    id                      text PRIMARY KEY,
    opp_type                text NOT NULL,
    event_id                text NOT NULL,
    event_label             text,
    sport                   text,
    league                  text,
    start_time              timestamptz,
    market_key              text NOT NULL,
    margin_pct              double precision NOT NULL,
    score                   double precision,
    score_breakdown         jsonb,                -- persisted for later ML (spec §13)
    urgency                 text,
    timing                  text,
    rule_risk               boolean DEFAULT false,
    mirrored                boolean DEFAULT false,
    total_stake_zar         double precision,
    guaranteed_profit_zar   double precision,
    executable_zar_per_leg  double precision,
    fx_rate                 double precision,
    first_seen              timestamptz NOT NULL,
    last_seen               timestamptz NOT NULL,
    peak_margin_pct         double precision,
    state                   text NOT NULL DEFAULT 'active',
    window_s                double precision,
    notes                   jsonb
);
CREATE INDEX IF NOT EXISTS idx_opps_state_score ON opportunities (state, score DESC);
CREATE INDEX IF NOT EXISTS idx_opps_first_seen ON opportunities (first_seen);

CREATE TABLE IF NOT EXISTS opportunity_legs (
    opportunity_id  text NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    idx             int NOT NULL,
    venue_id        text NOT NULL,
    outcome         text NOT NULL,
    selection_label text,
    odds            double precision NOT NULL,
    raw_price       double precision,
    fee_rate        double precision,
    stake_zar       double precision,
    deep_link       text,
    rules_group     text,
    is_pm           boolean DEFAULT false,
    token_id        text,
    max_stake_zar   double precision,
    order_index     int,
    PRIMARY KEY (opportunity_id, idx)
);

CREATE TABLE IF NOT EXISTS opportunity_lifecycles (
    id              bigserial PRIMARY KEY,
    opportunity_id  text NOT NULL,
    ts              timestamptz NOT NULL DEFAULT now(),
    margin_pct      double precision,
    state           text NOT NULL,                -- detected | update | expired
    note            text
);
CREATE INDEX IF NOT EXISTS idx_lifecycles_opp ON opportunity_lifecycles (opportunity_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
    id              bigserial PRIMARY KEY,
    opportunity_id  text NOT NULL,
    channel         text NOT NULL DEFAULT 'telegram',
    kind            text,                         -- new | improved
    ok              boolean,
    dry_run         boolean,
    payload         jsonb,
    ts              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS placements (
    id               bigserial PRIMARY KEY,
    opportunity_id   text NOT NULL,
    status           text NOT NULL,               -- placed | missed | voided | partial
    leg_idx          int,
    actual_odds      double precision,
    actual_stake_zar double precision,
    note             text,
    ts               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_placements_opp ON placements (opportunity_id);
