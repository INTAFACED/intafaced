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

-- One statement scan per merchant. The row is a concurrency slot, not a
-- balance and not a fee. expires_at is the bound after which a crashed scan
-- can be replaced. The scan deletes its own lease_id when it finishes.

CREATE TABLE IF NOT EXISTS "pay"."merchant_statement_leases" (
  "merchant_id" uuid PRIMARY KEY REFERENCES "pay"."merchants"("id") ON DELETE CASCADE,
  "lease_id"    uuid NOT NULL,
  "expires_at"  timestamptz NOT NULL
);
