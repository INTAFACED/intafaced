-- Reverses 20261029202738_copy_close_only.sql. A close-only follow becomes STOPPING with its copying grant revoked, as a plain stop leaves it.
DROP TABLE IF EXISTS "trade"."copy_close_orders";

UPDATE "trade"."copy_follows" SET "relationship_state" = 'STOPPING', "session_key_revoked" = true WHERE "relationship_state" = 'CLOSE_ONLY';

ALTER TABLE "trade"."copy_follows"
  DROP CONSTRAINT IF EXISTS "copy_follows_relationship_state_ck";

ALTER TABLE "trade"."copy_follows"
  ADD CONSTRAINT "copy_follows_relationship_state_ck"
  CHECK ("relationship_state" IN ('ACTIVE', 'PAUSED', 'STOPPING', 'DETACHED'));
