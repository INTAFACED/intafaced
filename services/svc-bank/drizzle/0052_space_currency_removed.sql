-- Remove a currency from an account (BK-acct-01).
--
-- A currency on an account is its primary space: the label over the customer's `userAvailable` ledger account for that
-- asset. Removing one hides that label; it moves no value and the ledger account stays the customer's. `removed_at` is
-- set only on a primary space, only while every account the customer holds in that asset is at zero and no named space
-- uses the asset. Money that arrives later clears it on the next read, so a funded account is never hidden.
--
-- Reversal: 0052_space_currency_removed.down.sql

ALTER TABLE "bank"."spaces" ADD COLUMN IF NOT EXISTS "removed_at" timestamptz;

ALTER TABLE "bank"."spaces" DROP CONSTRAINT IF EXISTS "spaces_removed_primary_only_ck";
ALTER TABLE "bank"."spaces" ADD CONSTRAINT "spaces_removed_primary_only_ck"
  CHECK ("removed_at" IS NULL OR "kind" = 'primary');
