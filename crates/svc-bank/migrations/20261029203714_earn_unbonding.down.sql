-- Reverses 20261029203714. Fails closed: a saving that is unbonding, a pool that unbonds and an approved status change
-- are all things savers and operators were told, so this never drops one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."earn_positions" WHERE "unbonds_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'earn savings have unbonding requests; 20261029203714 is not reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM "bank"."earn_pools" WHERE "unbonding_days" IS NOT NULL) THEN
    RAISE EXCEPTION 'staking-style earn pools exist; 20261029203714 is not reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM "bank"."earn_pool_status_changes") THEN
    RAISE EXCEPTION 'earn pool status changes are recorded; 20261029203714 is not reversed';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "earn_pool_status_changes_append_only_trg" ON "bank"."earn_pool_status_changes";
DROP FUNCTION IF EXISTS "bank"."earn_pool_status_changes_append_only"();
DROP TABLE IF EXISTS "bank"."earn_pool_status_changes";
DROP INDEX IF EXISTS "bank"."earn_positions_unbonds_at_idx";
ALTER TABLE "bank"."earn_positions" DROP CONSTRAINT IF EXISTS "earn_positions_unbonding_pair_ck";
ALTER TABLE "bank"."earn_positions" DROP COLUMN IF EXISTS "unbonds_at";
ALTER TABLE "bank"."earn_positions" DROP COLUMN IF EXISTS "unbonding_started_at";
ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_status_revision_ck";
ALTER TABLE "bank"."earn_pools" DROP COLUMN IF EXISTS "status_revision";
ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_unbonding_flexible_ck";
ALTER TABLE "bank"."earn_pools" DROP COLUMN IF EXISTS "unbonding_days";
