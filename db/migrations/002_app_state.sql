-- 002 · Durable application state
--
-- Everything that previously lived in local JSON files. Needed because a
-- serverless host has a read-only, ephemeral filesystem — so on Vercel these
-- tables are the only place config, halt state, the vault and the paper book
-- can survive a request.
--
-- Two shapes, deliberately:
--
--   app_state — one row per key, last write wins. Suits mutable singletons:
--               config, halt state, the credential vault.
--   app_log   — append-only, ordered. Suits history: audit trails, fills,
--               orders. Never updated, never deleted except by an explicit
--               reset, so a crash costs at most the last entry.
--
-- Deliberately NOT hypertables. These are small and queried by key rather than
-- by time range; a hypertable would add chunk management for no benefit. The
-- market-data tables in 001 are the ones that need Timescale.
--
-- This migration must also run on plain Postgres — Neon does not have the
-- TimescaleDB extension — so nothing here depends on it.

CREATE TABLE IF NOT EXISTS app_state (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_log (
  id         bigserial   PRIMARY KEY,
  stream     text        NOT NULL,
  entry      jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Reads are always "this stream, in order", so the index matches that exactly.
CREATE INDEX IF NOT EXISTS app_log_stream_id ON app_log (stream, id);
