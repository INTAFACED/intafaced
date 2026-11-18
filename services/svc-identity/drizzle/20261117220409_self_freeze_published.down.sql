-- Reverses 20261117220409_self_freeze_published.sql. Freezes are no longer announced; the freezes themselves are kept.
DROP INDEX IF EXISTS "identity"."account_self_freezes_unpublished_idx";
ALTER TABLE "identity"."account_self_freezes" DROP COLUMN IF EXISTS "published_at";
