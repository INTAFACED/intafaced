-- trade.copy · leader events followers can read (TRD-0681)
-- Reversal: 0065_copy_leader_events.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by COPYLEADERS before this file was written.
--
-- Append-only. published_detail is what a follower may see. The operator's
-- reason stays on the audit row from 0064 and is not a column here.
-- capacity_full is once per leader ref.

CREATE TABLE IF NOT EXISTS trade.copy_leader_events (
  event_id uuid PRIMARY KEY,
  leader_ref text NOT NULL,
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  published_detail jsonb NOT NULL,
  CONSTRAINT copy_leader_events_kind_ck CHECK (kind IN (
    'listing_edited',
    'strategy_version_changed',
    'suspended',
    'resumed',
    'delisted',
    'capacity_full'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS copy_leader_events_capacity_full_once_idx
  ON trade.copy_leader_events (leader_ref)
  WHERE kind = 'capacity_full';

CREATE INDEX IF NOT EXISTS copy_leader_events_leader_idx
  ON trade.copy_leader_events (leader_ref, occurred_at DESC, event_id DESC);

DROP TRIGGER IF EXISTS copy_leader_events_append_only ON trade.copy_leader_events;
CREATE TRIGGER copy_leader_events_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_leader_events
  FOR EACH ROW EXECUTE FUNCTION trade.copy_leader_append_only();
