-- intafaced:destructive replaces the one-open-application index and the approved check so a pooled master application fits the same queue; no row is dropped
-- trade.copy · pooled masters: the master application, the pool it creates, and the pool whitelist
-- (CB-copy-pro-share-11, CB-copy-pro-share-04 creation, CB-copy-pro-share-06, J-copy-bots-otc-10 #6)
-- Reversal: 20261104123350_copy_pool_masters.down.sql
--
-- A pooled master application enters the same founders' review queue as a lead application (one table, a kind
-- column): two founders approve it, and an approved pooled master may create one pool. The pool is a limit and a
-- lifecycle row, never a balance: every money door of a pool refuses until the ledger owner adds the pool recipes.
-- Founders add investors to a pool's whitelist by account id, at most the owner's batch limit per import. No money
-- moves here.

ALTER TABLE trade.copy_lead_applications ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'lead';
ALTER TABLE trade.copy_lead_applications ADD COLUMN IF NOT EXISTS contact text;
ALTER TABLE trade.copy_lead_applications ADD COLUMN IF NOT EXISTS style text;
ALTER TABLE trade.copy_lead_applications DROP CONSTRAINT IF EXISTS copy_lead_applications_kind_ck;
ALTER TABLE trade.copy_lead_applications ADD CONSTRAINT copy_lead_applications_kind_ck CHECK (
  (kind = 'lead' AND contact IS NULL AND style IS NULL)
  OR (
    kind = 'pool_master'
    AND length(btrim(coalesce(contact, ''))) BETWEEN 1 AND 200
    AND length(btrim(coalesce(style, ''))) BETWEEN 1 AND 500
  )
);
-- An approved lead is listed (a leader ref); an approved pooled master is not listed in the leader directory.
ALTER TABLE trade.copy_lead_applications DROP CONSTRAINT IF EXISTS copy_lead_applications_approved_ck;
ALTER TABLE trade.copy_lead_applications ADD CONSTRAINT copy_lead_applications_approved_ck CHECK (
  status <> 'approved'
  OR (
    approver_id IS NOT NULL
    AND (kind = 'pool_master' OR leader_ref IS NOT NULL)
    AND lower(btrim(approver_id)) <> lower(btrim(proposed_by))
  )
);
-- One open application per person and kind: a lead application and a pooled master application may both wait.
DROP INDEX IF EXISTS trade.copy_lead_applications_open_idx;
CREATE UNIQUE INDEX IF NOT EXISTS copy_lead_applications_open_kind_idx
  ON trade.copy_lead_applications (user_id, kind) WHERE status IN ('pending', 'awaiting_second');

CREATE TABLE IF NOT EXISTS trade.copy_pools (
  id uuid PRIMARY KEY,
  master_user_id text NOT NULL CONSTRAINT copy_pools_master_ck CHECK (length(btrim(master_user_id)) > 0),
  application_id uuid NOT NULL REFERENCES trade.copy_lead_applications (id),
  name text NOT NULL CONSTRAINT copy_pools_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  strategy_type text NOT NULL CONSTRAINT copy_pools_type_ck CHECK (strategy_type IN ('stable', 'aggressive')),
  -- The owner's limits for the type when the pool was created, as decimal strings.
  max_leverage text NOT NULL,
  max_drawdown_pct text NOT NULL,
  max_capital text NOT NULL,
  state text NOT NULL DEFAULT 'strategy_creation',
  client_request_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT copy_pools_state_ck CHECK (
    state IN ('strategy_creation', 'seed_round', 'trading', 'settlement', 'matured', 'terminated')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS copy_pools_request_idx ON trade.copy_pools (client_request_id);
-- One active strategy per master.
CREATE UNIQUE INDEX IF NOT EXISTS copy_pools_one_active_idx ON trade.copy_pools (master_user_id) WHERE state <> 'terminated';

CREATE TABLE IF NOT EXISTS trade.copy_pool_whitelist_imports (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES trade.copy_pools (id),
  client_request_id text NOT NULL,
  user_ids jsonb NOT NULL,
  imported_by text NOT NULL CONSTRAINT copy_pool_whitelist_imports_by_ck CHECK (length(btrim(imported_by)) > 0),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS copy_pool_whitelist_imports_request_idx ON trade.copy_pool_whitelist_imports (client_request_id);

CREATE TABLE IF NOT EXISTS trade.copy_pool_whitelist (
  pool_id uuid NOT NULL REFERENCES trade.copy_pools (id),
  user_id text NOT NULL CONSTRAINT copy_pool_whitelist_user_ck CHECK (length(btrim(user_id)) > 0),
  import_id uuid NOT NULL REFERENCES trade.copy_pool_whitelist_imports (id),
  added_by text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (pool_id, user_id)
);

DROP TRIGGER IF EXISTS copy_pool_whitelist_imports_append_only ON trade.copy_pool_whitelist_imports;
CREATE TRIGGER copy_pool_whitelist_imports_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_pool_whitelist_imports
  FOR EACH ROW EXECUTE FUNCTION trade.copy_leader_append_only();
