-- Event Markets desk. Namespaced into its own schema so the two desks
-- can never collide on a generic table name like markets or events.
CREATE SCHEMA IF NOT EXISTS events;
SET search_path TO events, public;

-- 004: cross-process runtime flags.
--
-- The kill switch has to work from wherever the operator is standing — the hosted
-- dashboard on Vercel, the local terminal, or a Compose deployment — so it lives in
-- the shared database rather than in one process's hot state. The Python scheduler
-- mirrors this into Redis each sweep; the Next.js API reads and writes it directly.

CREATE TABLE IF NOT EXISTS runtime_flags (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
);

INSERT INTO runtime_flags (key, value, updated_by)
VALUES ('kill_switch', 'false'::jsonb, 'migration')
ON CONFLICT (key) DO NOTHING;
