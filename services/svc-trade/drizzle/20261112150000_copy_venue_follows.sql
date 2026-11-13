-- trade.copy_venue_follows · a follow that copies on the venue, bound to one of the follower's own agent accounts
-- (J-copy-bots-otc-03; src/copy/venue-copy.ts). Reversal: 20261112150000_copy_venue_follows.down.sql
--
-- Written before the follow is saved. From then on every copy and close of the follow is a venue order on that agent
-- account's sub-account, placed by its agent permission; nothing here is a balance. A binding never changes and is never
-- deleted: the follow's copies on the venue are read through it for as long as the follow's record is kept.

CREATE TABLE IF NOT EXISTS trade.copy_venue_follows (
  follow_id text PRIMARY KEY CONSTRAINT copy_venue_follows_follow_ck CHECK (length(btrim(follow_id)) > 0),
  follower_id text NOT NULL,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (follower_id, account_id) REFERENCES trade.user_venue_agent_accounts (user_id, account_id)
);

CREATE INDEX IF NOT EXISTS copy_venue_follows_account_idx ON trade.copy_venue_follows (follower_id, account_id);

CREATE OR REPLACE FUNCTION trade.copy_venue_follows_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trade.copy_venue_follows: a binding never changes and is never deleted.' USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS copy_venue_follows_fixed_trg ON trade.copy_venue_follows;
CREATE TRIGGER copy_venue_follows_fixed_trg
  BEFORE UPDATE OR DELETE ON trade.copy_venue_follows
  FOR EACH ROW EXECUTE FUNCTION trade.copy_venue_follows_fixed();
