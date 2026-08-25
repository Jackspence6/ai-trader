-- Event Markets desk. Namespaced into its own schema so the two desks
-- can never collide on a generic table name like markets or events.
CREATE SCHEMA IF NOT EXISTS events;
SET search_path TO events, public;

-- 003: Phase 2 accounts & promos — created EMPTY now so the schema is interfaced
-- from day one (spec §1, §8). STRICT POLICY: one genuine person per account set;
-- no multi-accounting, ever (spec: explicit non-goals).

CREATE TABLE IF NOT EXISTS persons (
    id          text PRIMARY KEY,
    full_name   text NOT NULL,
    -- One genuine person per account set — enforced at application level too.
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
    id            text PRIMARY KEY,
    person_id     text NOT NULL REFERENCES persons(id),
    venue_id      text NOT NULL,
    health_state  text NOT NULL DEFAULT 'healthy',  -- healthy | watched | limited | gubbed | closed
    opened_at     timestamptz,
    closed_at     timestamptz,
    UNIQUE (person_id, venue_id)                    -- one account per person per venue
);

CREATE TABLE IF NOT EXISTS bankrolls (
    account_id   text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    balance_zar  double precision NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promos (
    id                 text PRIMARY KEY,
    venue_id           text NOT NULL,
    name               text NOT NULL,
    promo_type         text NOT NULL,              -- signup | reload | boost
    bonus_pct          double precision,
    max_bonus_zar      double precision,
    min_odds           double precision,
    rollover_multiple  double precision,
    one_per_household  boolean DEFAULT true,
    terms              text,
    active             boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS wagering_progress (
    id                      bigserial PRIMARY KEY,
    account_id              text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    promo_id                text NOT NULL REFERENCES promos(id),
    required_turnover_zar   double precision NOT NULL,
    completed_turnover_zar  double precision NOT NULL DEFAULT 0,
    deadline                timestamptz,
    state                   text DEFAULT 'in_progress'
);

CREATE TABLE IF NOT EXISTS account_health_events (
    id          bigserial PRIMARY KEY,
    account_id  text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ts          timestamptz NOT NULL DEFAULT now(),
    event_type  text NOT NULL,                     -- stake_limited | promo_excluded | kyc_request | ...
    detail      jsonb
);

-- Promo structures researched in the spec (§23 key findings) — reference rows for
-- Phase-2 EV/hedge math prototyping. Terms must be re-verified before use.
INSERT INTO promos (id, venue_id, name, promo_type, bonus_pct, max_bonus_zar, min_odds,
                    rollover_multiple, one_per_household, terms, active)
VALUES
  ('wsb_signup_2026', 'wsb', 'WSB 100% deposit match', 'signup', 100, 20000, 1.50, 5, true,
   'One bonus per person/household/IP. 5x rollover at min odds 1.50. RE-VERIFY before relying on.', false),
  ('betway_signup_2026', 'betway_sa', 'Betway signup bonus', 'signup', 100, 1000, NULL, 3, true,
   '3x rollover. RE-VERIFY before relying on.', false),
  ('betfred_signup_2026', 'betfred_sa', 'Betfred SA signup bonus', 'signup', 100, 5000, NULL, 5, true,
   '5x rollover. RE-VERIFY before relying on.', false),
  ('hwb_bonus_2026', 'hollywoodbets', 'Hollywoodbets bonus (odds >= 1.50)', 'signup', NULL, NULL, 1.50,
   NULL, true, 'Bonuses require odds >= 5/10 (1.50). RE-VERIFY before relying on.', false)
ON CONFLICT (id) DO NOTHING;
