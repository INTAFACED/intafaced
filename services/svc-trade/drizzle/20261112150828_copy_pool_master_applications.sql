-- trade.copy · pooled master applications (CB-copy-pro-share-11, J-copy-bots-otc-10 #6)
-- Reversal: 20261112150828_copy_pool_master_applications.down.sql
--
-- A customer applies, from the master center, to run a pooled strategy. The application waits beside the lead
-- applications for the founders to see. One application per person, under its business key `pool.apply:<userId>`, so
-- the same submit twice is one row. Running a pool holds followers' money, which is the custodial layer (OWNER 226):
-- no pool is created here, nothing is approved here and no money moves.

CREATE TABLE IF NOT EXISTS trade.copy_pool_master_applications (
  id uuid PRIMARY KEY,
  key text NOT NULL CONSTRAINT copy_pool_master_applications_key_ck CHECK (key = 'pool.apply:' || user_id),
  user_id text NOT NULL CONSTRAINT copy_pool_master_applications_user_ck CHECK (length(btrim(user_id)) > 0),
  nickname text NOT NULL CONSTRAINT copy_pool_master_applications_nickname_ck CHECK (length(btrim(nickname)) BETWEEN 1 AND 80),
  style text NOT NULL CONSTRAINT copy_pool_master_applications_style_ck CHECK (length(btrim(style)) BETWEEN 1 AND 280),
  status text NOT NULL DEFAULT 'applied' CONSTRAINT copy_pool_master_applications_status_ck CHECK (status IN ('applied')),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS copy_pool_master_applications_key_idx ON trade.copy_pool_master_applications (key);
CREATE INDEX IF NOT EXISTS copy_pool_master_applications_queue_idx ON trade.copy_pool_master_applications (created_at, id);

DROP TRIGGER IF EXISTS copy_pool_master_applications_append_only ON trade.copy_pool_master_applications;
CREATE TRIGGER copy_pool_master_applications_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_pool_master_applications
  FOR EACH ROW EXECUTE FUNCTION trade.copy_leader_append_only();
