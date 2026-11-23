-- Restore the pre-0020 default and the NOT NULL. Stored rows are not rewritten.
-- SET NOT NULL fails if a blank floor is already stored.

ALTER TABLE "bank"."earn_pools" ALTER COLUMN "min_deposit" SET DEFAULT 0;

ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_min_deposit_non_negative_ck";
ALTER TABLE "bank"."earn_pools" ADD CONSTRAINT "earn_pools_min_deposit_non_negative_ck"
  CHECK ("min_deposit" >= 0);

ALTER TABLE "bank"."earn_pools" ALTER COLUMN "min_deposit" SET NOT NULL;
