-- Reverses 20261029202738_copy_close_only.sql. A close-only follow becomes STOPPING, which takes nothing new either.
DROP TABLE IF EXISTS "trade"."copy_close_orders";

UPDATE "trade"."copy_follows" SET "relationship_state" = 'STOPPING' WHERE "relationship_state" = 'CLOSE_ONLY';

ALTER TABLE "trade"."copy_follows"
  DROP CONSTRAINT IF EXISTS "copy_follows_relationship_state_ck";

ALTER TABLE "trade"."copy_follows"
  ADD CONSTRAINT "copy_follows_relationship_state_ck"
  CHECK ("relationship_state" IN ('ACTIVE', 'PAUSED', 'STOPPING', 'DETACHED'));
