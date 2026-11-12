-- trade.copy · the lead's own desk: removing copiers and stopping leading (CB-copy-15, CB-copy-18; J-copy-bots-otc-05)
-- Reversal: 20261112150952_copy_lead_own_desk.down.sql
--
-- copy_lead_removals: one row per copier a lead removed, written once under its business key
-- copy.lead.remove:<follow_id>. The lead's daily removal limit (an owner value) counts these rows by the server's UTC
-- day. Removing ends the follow (detached, its reserve released); nothing posts and no money moves.
--
-- copy_lead_stops: a lead's request to stop leading one listing. review_pending until a founder decides; approved moves
-- the listing to delisted through the leader directory, failed keeps it listed. One open request per lead. Keyed
-- copy.lead.stop:<leader_ref>:<client_request_id>, so the same request sent twice is one row.

CREATE TABLE IF NOT EXISTS trade.copy_lead_removals (
  removal_key text PRIMARY KEY,
  leader_id text NOT NULL,
  follow_id text NOT NULL UNIQUE,
  follower_id text NOT NULL,
  reason text,
  removed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS copy_lead_removals_day_idx ON trade.copy_lead_removals (leader_id, removed_at);

CREATE TABLE IF NOT EXISTS trade.copy_lead_stops (
  id uuid PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  leader_id text NOT NULL,
  leader_ref text NOT NULL,
  market_mode text NOT NULL,
  state text NOT NULL DEFAULT 'review_pending',
  decided_by text,
  decision_reason text,
  requested_at timestamptz NOT NULL,
  decided_at timestamptz,
  CONSTRAINT copy_lead_stops_state_ck CHECK (state IN ('review_pending', 'approved', 'failed')),
  CONSTRAINT copy_lead_stops_decided_ck CHECK (state = 'review_pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS copy_lead_stops_open_idx ON trade.copy_lead_stops (leader_id) WHERE state = 'review_pending';
CREATE INDEX IF NOT EXISTS copy_lead_stops_queue_idx ON trade.copy_lead_stops (requested_at, id) WHERE state = 'review_pending';
