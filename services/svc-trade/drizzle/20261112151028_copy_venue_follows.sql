-- trade.copy_venue_follows, trade.copy_venue_leads · copy trading on the person's own venue account (J-copy-bots-otc-01
-- #7 #8; src/copy/venue-copy.ts). Reversal: 20261112151028_copy_venue_follows.down.sql
--
-- At launch INTAFACED holds no customer money (OWNER 226): a follow on the venue holds and moves nothing. Its cap is a
-- limit, checked by our policy before the follow's agent key signs a copy; the venue is the record of the follower's
-- balances, orders and fills. A row here is the follow's agent permission: the key INTAFACED holds for this follow
-- (agent-key.ts, derived from the follow id), which the follower's wallet approves on their own venue account, and which
-- can place and cancel orders there and never withdraw. The follow itself (trade.copy_follows) is written only once the
-- venue's record lists that permission, so a rejected signature leaves no follow.
--
-- copy_venue_leads names the venue account a listed lead trades on, set by the operator who lists the lead: the copy
-- driver reads the lead's fills from the venue's record of that account.

CREATE TABLE IF NOT EXISTS trade.copy_venue_follows (
  follow_id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT copy_venue_follows_user_ck CHECK (length(btrim(user_id)) > 0),
  client_request_id text NOT NULL,
  leader_id text NOT NULL,
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT copy_venue_follows_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  agent_address text NOT NULL CONSTRAINT copy_venue_follows_agent_ck CHECK (agent_address ~ '^0x[0-9a-f]{40}$'),
  asset text NOT NULL,
  -- The follow's cap: the most all its copies together may commit, as a canonical decimal string.
  cap text NOT NULL CONSTRAINT copy_venue_follows_cap_ck CHECK (cap ~ '^[0-9]+(\.[0-9]+)?$' AND cap !~ '^0+(\.0+)?$'),
  -- The person's Start copying request, kept so the follow is written with exactly these terms once signed.
  request jsonb NOT NULL,
  status text NOT NULL CONSTRAINT copy_venue_follows_status_ck CHECK (status IN ('signing', 'active', 'abandoned')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  active_at timestamptz,
  CONSTRAINT copy_venue_follows_active_ck CHECK (status <> 'active' OR active_at IS NOT NULL)
);

-- One agent key per follow, ever: an address is never approved twice.
CREATE UNIQUE INDEX IF NOT EXISTS copy_venue_follows_agent_uq ON trade.copy_venue_follows (agent_address);
CREATE INDEX IF NOT EXISTS copy_venue_follows_user_idx ON trade.copy_venue_follows (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade.copy_venue_leads (
  leader_user_id text PRIMARY KEY CONSTRAINT copy_venue_leads_user_ck CHECK (length(btrim(leader_user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT copy_venue_leads_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS copy_venue_leads_owner_idx ON trade.copy_venue_leads (venue_id, owner);
