-- trade.copy_follows · one live follow per follower and leader, not one ever (J-copy-bots-otc-02 #1: a new follow after
-- stopping may use another mode). A stopped follow (STOPPING, CLOSE_ONLY or DETACHED) can never copy a new trade again,
-- so it no longer holds its leader; an ACTIVE or PAUSED one still does. Reversal:
-- 20261112235626_copy_follow_one_live_per_leader.down.sql

DROP INDEX IF EXISTS "trade"."copy_follows_follower_leader_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "copy_follows_follower_leader_live_idx"
  ON "trade"."copy_follows" ("follower_id", "leader_id")
  WHERE "relationship_state" IN ('ACTIVE', 'PAUSED');

CREATE INDEX IF NOT EXISTS "copy_follows_follower_leader_idx"
  ON "trade"."copy_follows" ("follower_id", "leader_id");
