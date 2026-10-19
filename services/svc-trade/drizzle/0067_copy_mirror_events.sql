-- trade.copy · append-only mirror trail (COPYRESULT, TRD-0858)
-- Reversal: 0067_copy_mirror_events.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by COPYRESULT before this file was written.
--
-- Rejects, skips and divergence were only thrown refusals. This table stores the
-- trail a follow can show: leader intent, plan, place, partial, fill, refusal,
-- skip, and the signed price difference. Rows are immutable the way
-- ledger.ledger_entries is: UPDATE and DELETE are refused by the database.
-- Emptying the whole table (test harness reset) stays allowed; the acceptance bar is UPDATE and DELETE.
--
-- Replay of the same leader fill inserts nothing new. intent/planned/placed/
-- rejected/skipped/divergence are unique per follow and leader fill. partial
-- and filled are unique per follower fill, so a later fill of the same leader
-- fill is a new row and a redelivery of the same follower fill is not.

CREATE OR REPLACE FUNCTION trade.copy_mirror_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'copy_mirror_events is append-only: % refused', TG_OP
    USING ERRCODE = '23514';
END;
$$;

CREATE TABLE IF NOT EXISTS trade.copy_mirror_events (
  event_id          uuid PRIMARY KEY,
  follow_id         text NOT NULL,
  leader_fill_id    text NOT NULL,
  kind              text NOT NULL,
  follower_order_id text,
  follower_fill_id  text,
  quantity          numeric(38, 18),
  price             numeric(38, 18),
  basis_points      bigint,
  code              text,
  occurred_at       timestamptz NOT NULL,
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT copy_mirror_events_kind_ck
    CHECK (kind IN ('intent', 'planned', 'placed', 'partial', 'filled', 'rejected', 'skipped', 'divergence'))
);

CREATE UNIQUE INDEX IF NOT EXISTS copy_mirror_events_step_uidx
  ON trade.copy_mirror_events (follow_id, leader_fill_id, kind)
  WHERE kind IN ('intent', 'planned', 'placed', 'rejected', 'skipped', 'divergence');

CREATE UNIQUE INDEX IF NOT EXISTS copy_mirror_events_fill_uidx
  ON trade.copy_mirror_events (follow_id, leader_fill_id, kind, follower_fill_id)
  WHERE kind IN ('partial', 'filled');

CREATE INDEX IF NOT EXISTS copy_mirror_events_follow_time_idx
  ON trade.copy_mirror_events (follow_id, occurred_at, seq);

DROP TRIGGER IF EXISTS copy_mirror_events_append_only ON trade.copy_mirror_events;
CREATE TRIGGER copy_mirror_events_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_mirror_events
  FOR EACH ROW EXECUTE FUNCTION trade.copy_mirror_events_append_only();
