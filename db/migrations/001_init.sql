-- 001 · Initial schema
--
-- requires: timescaledb
--
-- Skipped automatically where the TimescaleDB extension is unavailable (Neon,
-- and most managed Postgres). That is fine and intended: these are the
-- market-data tables, written by the recorder on a box we control. The
-- serverless dashboard never writes them, so it does not need them.
--
-- Three hypertables mirroring the recorder's three streams, plus NAV history.
--
-- Design notes:
--
--   * Every table carries `recorded_at` as the time dimension, which is the
--     moment WE observed the data — not the venue's own timestamp. Those differ
--     by our latency, and a backtest must replay what we actually saw when we
--     saw it. Venue timestamps are kept alongside where available.
--
--   * Natural keys are used for idempotency so re-importing a JSONL file is
--     safe. Imports are `ON CONFLICT DO NOTHING`; a re-run after a crash must
--     not duplicate rows or fail.
--
--   * `numeric` rather than `double precision` for anything monetary. Binary
--     floating point cannot represent 0.1 exactly, and accumulated rounding in
--     a fee ledger is the kind of error that surfaces as an unexplained
--     reconciliation mismatch six months later.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------- quotes

CREATE TABLE IF NOT EXISTS quotes (
  recorded_at      timestamptz  NOT NULL,
  venue            text         NOT NULL,
  asset            text         NOT NULL,
  kind             text         NOT NULL,   -- spot | perp | error
  last             numeric,
  bid              numeric,
  ask              numeric,
  spread_bps       numeric,
  top_of_book_usd  numeric,
  high_24h         numeric,
  low_24h          numeric,
  change_24h_pct   numeric,
  volume_24h_usd   numeric,
  funding_rate     numeric,
  funding_interval_hours numeric,
  funding_apr      numeric,
  next_funding_ms  bigint,
  mark_price       numeric,
  index_price      numeric,
  open_interest_usd numeric,
  venue_ts         bigint,                  -- the venue's own timestamp
  error            text,                    -- set when kind = 'error'
  PRIMARY KEY (recorded_at, venue, asset, kind)
);

SELECT create_hypertable('quotes', 'recorded_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS quotes_asset_time ON quotes (asset, recorded_at DESC);
CREATE INDEX IF NOT EXISTS quotes_venue_time ON quotes (venue, recorded_at DESC);

-- --------------------------------------------------------------- funding
--
-- Settled funding prints. Keyed on the venue's own settlement time rather than
-- our observation time — the same print is re-observed on every poll, and we
-- want one row per settlement, not one per poll.

CREATE TABLE IF NOT EXISTS funding (
  funding_time  timestamptz NOT NULL,
  venue         text        NOT NULL,
  asset         text        NOT NULL,
  rate          numeric     NOT NULL,
  apr           numeric     NOT NULL,
  recorded_at   timestamptz NOT NULL,
  PRIMARY KEY (funding_time, venue, asset)
);

SELECT create_hypertable('funding', 'funding_time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS funding_asset_time ON funding (asset, funding_time DESC);

-- ------------------------------------------------------------------ scan
--
-- Every opportunity scored and the decision taken. This is the evidence base:
-- market data records what happened, this records what we would have done.

CREATE TABLE IF NOT EXISTS scan (
  recorded_at       timestamptz NOT NULL,
  opportunity_id    text        NOT NULL,
  strategy          text        NOT NULL,
  strategy_name     text,
  asset             text        NOT NULL,
  route             text,
  risk_tier         text,
  sleeve_id         text,
  sleeve_name       text,
  gross_bps         numeric,
  fees_bps          numeric,
  spread_bps        numeric,
  slippage_bps      numeric,
  drag_bps          numeric,
  net_bps           numeric,
  net_apr           numeric,
  breakeven_days    numeric,
  capital_required_usd numeric,
  notional_usd      numeric,
  expected_profit_usd  numeric,
  funding_apr       numeric,
  taken             boolean     NOT NULL DEFAULT false,
  would_take        boolean     NOT NULL DEFAULT false,
  rejection_code    text,
  rejection_detail  text,
  PRIMARY KEY (recorded_at, opportunity_id)
);

SELECT create_hypertable('scan', 'recorded_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS scan_strategy_time ON scan (strategy, recorded_at DESC);
CREATE INDEX IF NOT EXISTS scan_rejection ON scan (rejection_code, recorded_at DESC);
CREATE INDEX IF NOT EXISTS scan_would_take ON scan (would_take, recorded_at DESC);

-- ----------------------------------------------------------- nav_history
--
-- The series the capital ladder reads. Tier promotion requires NAV to hold
-- above a threshold for 7 consecutive days, which is impossible to evaluate
-- without this — it is why the ladder is currently frozen at T0.

CREATE TABLE IF NOT EXISTS nav_history (
  observed_at   timestamptz NOT NULL,
  nav_usd       numeric     NOT NULL,
  source        text        NOT NULL,   -- 'manual' | 'venue-sync'
  PRIMARY KEY (observed_at)
);

SELECT create_hypertable('nav_history', 'observed_at', if_not_exists => TRUE);

-- -------------------------------------------------------------- retention
--
-- Compression rather than deletion. DESIGN.md §4 archives raw data after 30
-- days; compressed hypertable chunks keep it queryable at roughly 10x smaller,
-- which is a better trade than throwing away the only copy of what we saw.

ALTER TABLE quotes SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'venue, asset, kind'
);

SELECT add_compression_policy('quotes', INTERVAL '30 days', if_not_exists => TRUE);

ALTER TABLE scan SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'strategy, asset'
);

SELECT add_compression_policy('scan', INTERVAL '30 days', if_not_exists => TRUE);
