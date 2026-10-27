-- Seasons, limited drops and their claims (RC-campaigns-04). Reversal: the matching .down.sql.
--
-- The campaigns schema is created by the database bootstrap. This role does not create schemas.
-- Nothing here is a balance. A drop in this version carries no value: a claim records an entitlement only.
-- Every operator change and every claim writes one audit row.

CREATE TABLE IF NOT EXISTS campaigns.seasons (
  id text PRIMARY KEY,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by text NOT NULL,
  published_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT seasons_window_ck CHECK (ends_at > starts_at),
  CONSTRAINT seasons_status_ck CHECK (status IN ('draft', 'published')),
  CONSTRAINT seasons_publish_ck CHECK (
    (status = 'draft' AND published_by IS NULL AND published_at IS NULL)
    OR (status = 'published' AND published_by IS NOT NULL AND published_at IS NOT NULL AND published_by <> created_by)
  )
);

CREATE TABLE IF NOT EXISTS campaigns.drops (
  id text PRIMARY KEY,
  title text NOT NULL,
  season_id text REFERENCES campaigns.seasons (id),
  total_count integer NOT NULL,
  remaining integer NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz,
  kind text NOT NULL DEFAULT 'entitlement',
  status text NOT NULL DEFAULT 'draft',
  created_by text NOT NULL,
  published_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT drops_count_ck CHECK (total_count > 0),
  CONSTRAINT drops_remaining_ck CHECK (remaining >= 0 AND remaining <= total_count),
  CONSTRAINT drops_window_ck CHECK (closes_at IS NULL OR closes_at > opens_at),
  CONSTRAINT drops_kind_ck CHECK (kind = 'entitlement'),
  CONSTRAINT drops_status_ck CHECK (status IN ('draft', 'published')),
  CONSTRAINT drops_publish_ck CHECK (
    (status = 'draft' AND published_by IS NULL AND published_at IS NULL)
    OR (status = 'published' AND published_by IS NOT NULL AND published_at IS NOT NULL AND published_by <> created_by)
  )
);

CREATE TABLE IF NOT EXISTS campaigns.drop_claims (
  claim_key text PRIMARY KEY,
  drop_id text NOT NULL REFERENCES campaigns.drops (id),
  account_id text NOT NULL,
  kind text NOT NULL DEFAULT 'entitlement',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drop_claims_one_per_account UNIQUE (drop_id, account_id),
  CONSTRAINT drop_claims_key_ck CHECK (claim_key = 'drop:' || drop_id || ':' || account_id),
  CONSTRAINT drop_claims_kind_ck CHECK (kind = 'entitlement')
);

CREATE INDEX IF NOT EXISTS drop_claims_account_idx ON campaigns.drop_claims (account_id);

CREATE TABLE IF NOT EXISTS campaigns.audit_log (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
