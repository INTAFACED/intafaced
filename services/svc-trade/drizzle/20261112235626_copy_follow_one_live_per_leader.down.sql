-- Reverse 20261112235626_copy_follow_one_live_per_leader.sql: one follow per follower and leader, ever. Fails, and changes
-- nothing, while a follower has followed the same leader again after stopping; those rows are kept, never deleted.
DROP INDEX IF EXISTS "trade"."copy_follows_follower_leader_live_idx";
DROP INDEX IF EXISTS "trade"."copy_follows_follower_leader_idx";
CREATE UNIQUE INDEX "copy_follows_follower_leader_idx"
  ON "trade"."copy_follows" ("follower_id", "leader_id");
