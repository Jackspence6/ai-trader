-- Event Markets desk. Namespaced into its own schema so the two desks
-- can never collide on a generic table name like markets or events.
CREATE SCHEMA IF NOT EXISTS events;
SET search_path TO events, public;

-- 001: canonical registry + events + odds time-series (Phase 1, spec §8)

CREATE TABLE IF NOT EXISTS venues (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    kind            text NOT NULL,               -- bookie | prediction_market
    currency        text NOT NULL DEFAULT 'ZAR',
    softness        double precision DEFAULT 0.5,
    min_interval_s  double precision DEFAULT 20,
    homepage        text,
    enabled         boolean DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leagues (
    id       text PRIMARY KEY,                    -- normalized canonical name
    sport    text NOT NULL,
    name     text NOT NULL
);

CREATE TABLE IF NOT EXISTS league_aliases (
    venue_id text NOT NULL DEFAULT '',            -- '' = global alias
    alias    text NOT NULL,
    league_id text NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    PRIMARY KEY (alias, venue_id)
);

CREATE TABLE IF NOT EXISTS teams (
    id     text PRIMARY KEY,
    sport  text,
    name   text NOT NULL
);

CREATE TABLE IF NOT EXISTS team_aliases (
    venue_id text NOT NULL DEFAULT '',            -- '' = global alias
    alias    text NOT NULL,
    team_id  text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    learned  boolean DEFAULT false,               -- self-learned vs seeded
    PRIMARY KEY (alias, venue_id)
);

CREATE TABLE IF NOT EXISTS players (
    id     text PRIMARY KEY,
    sport  text,
    name   text NOT NULL
);

CREATE TABLE IF NOT EXISTS player_aliases (
    venue_id  text NOT NULL DEFAULT '',           -- '' = global alias
    alias     text NOT NULL,
    player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    PRIMARY KEY (alias, venue_id)
);

CREATE TABLE IF NOT EXISTS events (
    id          text PRIMARY KEY,                 -- deterministic content hash
    sport       text NOT NULL,
    league_id   text,
    home        text,
    away        text,
    start_time  timestamptz,
    status      text DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_time);

CREATE TABLE IF NOT EXISTS venue_event_links (
    venue_id   text NOT NULL,
    event_id   text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    venue_ref  text NOT NULL,
    confidence double precision,
    matched_by text,                               -- alias | fuzzy | manual
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (venue_id, venue_ref)
);

CREATE TABLE IF NOT EXISTS markets (
    id          text PRIMARY KEY,                  -- event_id|market_key
    event_id    text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    market_key  text NOT NULL,
    market_type text NOT NULL,
    line        double precision,
    rules_notes text
);

CREATE TABLE IF NOT EXISTS match_reviews (
    id          text PRIMARY KEY,
    kind        text NOT NULL,                     -- team | league | event
    venue_id    text,
    raw_string  text NOT NULL,
    proposed    text,
    confidence  double precision,
    status      text NOT NULL DEFAULT 'pending',
    context     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

-- Odds time-series: Timescale hypertable when available, plain table otherwise.
CREATE TABLE IF NOT EXISTS odds_snapshots (
    ts             timestamptz NOT NULL,
    ts_source      timestamptz,
    venue_id       text NOT NULL,
    event_id       text NOT NULL,
    market_key     text NOT NULL,
    outcome        text NOT NULL,
    decimal_odds   double precision,               -- fee-adjusted for PM rows
    raw_price      double precision,               -- PM raw ask
    fee_rate       double precision,
    line           double precision,
    status         text,
    executable_zar double precision,
    token_id       text
);
CREATE INDEX IF NOT EXISTS idx_snapshots_evt ON odds_snapshots (event_id, market_key, ts DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_venue_ts ON odds_snapshots (venue_id, ts DESC);

DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS timescaledb;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'timescaledb extension unavailable — odds_snapshots stays a plain table';
    END;
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        PERFORM create_hypertable('odds_snapshots', 'ts', if_not_exists => TRUE,
                                  migrate_data => TRUE);
    END IF;
END $$;
