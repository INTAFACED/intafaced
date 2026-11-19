-- The owner's own freeze is announced on the bus (selfFreezeApplied, J-wallet-13 #1): each service that keeps a permission
-- for an agent to act for the person revokes it on that event. The relay publishes a freeze whose published_at is null and
-- then sets it, at least once. A freeze already lifted before this column existed has nothing left to stop, so it is
-- marked published; an open one is announced on the relay's first run.
-- Reversal: 20261117220409_self_freeze_published.down.sql

ALTER TABLE "identity"."account_self_freezes" ADD COLUMN IF NOT EXISTS "published_at" timestamptz;
UPDATE "identity"."account_self_freezes" SET "published_at" = COALESCE("lifted_at", now()) WHERE "state" = 'lifted' AND "published_at" IS NULL;
CREATE INDEX IF NOT EXISTS "account_self_freezes_unpublished_idx"
  ON "identity"."account_self_freezes" ("since") WHERE "published_at" IS NULL;
