-- trade.copy · pooled masters, pool whitelists and takeovers (CB-copy-pro-share-11, -06, -09; J-copy-bots-otc-10 #6, #7)
-- Reversal: 20261106080500_copy_pool_desk.down.sql
--
-- A customer applies to run a pool (nickname, contact, style) under the business key `pool.apply:<userId>`; the
-- founders read the applications on the copy desk, oldest first. Whitelists hold one row per pool and UID; a removed
-- investor may only redeem. A takeover is one row per pool and day under `pool.takeover:<poolId>:<day>`. Pools
-- themselves are not built yet (CB-copy-pro-share-04), so whitelists and takeovers stay empty until they are.
-- No money moves here.

CREATE TABLE IF NOT EXISTS trade.copy_pool_master_applications (
  id uuid PRIMARY KEY,
  request_key text NOT NULL CONSTRAINT copy_pool_master_applications_key_ck CHECK (request_key LIKE 'pool.apply:%'),
  user_id text NOT NULL CONSTRAINT copy_pool_master_applications_user_ck CHECK (length(btrim(user_id)) > 0),
  nickname text NOT NULL CONSTRAINT copy_pool_master_applications_nickname_ck CHECK (length(btrim(nickname)) BETWEEN 1 AND 80),
  contact text NOT NULL CONSTRAINT copy_pool_master_applications_contact_ck CHECK (length(btrim(contact)) BETWEEN 1 AND 200),
  style text NOT NULL CONSTRAINT copy_pool_master_applications_style_ck CHECK (length(btrim(style)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'applied',
  created_at timestamptz NOT NULL,
  CONSTRAINT copy_pool_master_applications_status_ck CHECK (status IN ('applied', 'approved', 'rejected'))
);
-- One open application per person, under its business key: the same submit again answers it.
CREATE UNIQUE INDEX IF NOT EXISTS copy_pool_master_applications_open_idx
  ON trade.copy_pool_master_applications (request_key) WHERE status = 'applied';
CREATE INDEX IF NOT EXISTS copy_pool_master_applications_queue_idx
  ON trade.copy_pool_master_applications (created_at, id);

CREATE TABLE IF NOT EXISTS trade.copy_pool_whitelist (
  pool_id text NOT NULL CONSTRAINT copy_pool_whitelist_pool_ck CHECK (length(btrim(pool_id)) > 0),
  investor_uid text NOT NULL CONSTRAINT copy_pool_whitelist_uid_ck CHECK (length(btrim(investor_uid)) > 0),
  state text NOT NULL DEFAULT 'active',
  import_key text NOT NULL,
  added_at timestamptz NOT NULL,
  removed_at timestamptz,
  PRIMARY KEY (pool_id, investor_uid),
  CONSTRAINT copy_pool_whitelist_state_ck CHECK (state IN ('active', 'removed')),
  CONSTRAINT copy_pool_whitelist_removed_ck CHECK ((state = 'removed') = (removed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS trade.copy_pool_takeovers (
  takeover_key text PRIMARY KEY,
  pool_id text NOT NULL CONSTRAINT copy_pool_takeovers_pool_ck CHECK (length(btrim(pool_id)) > 0),
  day date NOT NULL,
  trigger text NOT NULL CONSTRAINT copy_pool_takeovers_trigger_ck CHECK (trigger IN ('nav_floor', 'margin_rate')),
  created_at timestamptz NOT NULL,
  CONSTRAINT copy_pool_takeovers_key_ck CHECK (takeover_key = 'pool.takeover:' || pool_id || ':' || to_char(day, 'YYYY-MM-DD'))
);
CREATE INDEX IF NOT EXISTS copy_pool_takeovers_order_idx ON trade.copy_pool_takeovers (day DESC, pool_id);

-- A takeover row is a record of what happened: never changed or removed.
DROP TRIGGER IF EXISTS copy_pool_takeovers_append_only ON trade.copy_pool_takeovers;
CREATE TRIGGER copy_pool_takeovers_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_pool_takeovers
  FOR EACH ROW EXECUTE FUNCTION trade.copy_leader_append_only();
