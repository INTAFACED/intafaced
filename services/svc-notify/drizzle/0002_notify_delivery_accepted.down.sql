-- Reversal of 0002_notify_delivery_accepted.sql
--
-- Restores the `delivered_at` name and the `delivered` status literal. Nothing
-- is lost either way — the rename carries its data — but note that going back
-- restores a column that claims more than the service can prove. Reversibility
-- is a §14 requirement, not a recommendation to run this.

ALTER TABLE "notify"."deliveries" DROP CONSTRAINT IF EXISTS "deliveries_accepted_ck";

ALTER TABLE "notify"."deliveries" RENAME COLUMN "accepted_at" TO "delivered_at";

ALTER TABLE "notify"."deliveries" DROP CONSTRAINT IF EXISTS "deliveries_status_ck";

-- Rewrite accepted rows before the restored check. Adding the constraint
-- validates rows already stored, and `accepted` is not in the restored list.
UPDATE "notify"."deliveries" SET "status" = 'delivered' WHERE "status" = 'accepted';

ALTER TABLE "notify"."deliveries" ADD CONSTRAINT "deliveries_status_ck"
  CHECK ("status" IN ('pending', 'delivered', 'refused', 'failed', 'abandoned'));

ALTER TABLE "notify"."deliveries" DROP CONSTRAINT IF EXISTS "deliveries_delivered_ck";
ALTER TABLE "notify"."deliveries" ADD CONSTRAINT "deliveries_delivered_ck"
  CHECK (("status" = 'delivered') = ("delivered_at" IS NOT NULL));
