-- Page key for the merchant destination inventory.
--
-- pay.merchant_payout_destinations is keyed by (merchant_id, rail_id). The
-- merchant list cursor is (created_at, uuid). This id is only that cursor's
-- second half. It does not add a default flag, a screening result, or a second
-- destination per rail. One row per rail stays the rule.

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "id" uuid;

UPDATE "pay"."merchant_payout_destinations"
   SET "id" = gen_random_uuid()
 WHERE "id" IS NULL;

ALTER TABLE "pay"."merchant_payout_destinations"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "id" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_payout_destinations_id_idx"
  ON "pay"."merchant_payout_destinations" ("id");
