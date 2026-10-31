-- intafaced:destructive — reversal of 20261030184034_pay_payout_destination_activates_at.sql
--
-- A held destination is stored verified = false with activates_at ahead. Dropping the column would leave it looking
-- unverified, which is safe, but it would also forget that the owner verified it. So the reversal refuses while any
-- destination is still inside its hold: wait the holds out (or have the owners confirm again later), then re-run.
-- Read-only count of rows that block it:
--   SELECT count(*)::int FROM pay.merchant_payout_destinations WHERE verified = false AND activates_at > now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pay"."merchant_payout_destinations"
     WHERE "verified" = false AND "activates_at" IS NOT NULL AND "activates_at" > now()
  ) THEN
    RAISE EXCEPTION 'payout destinations are still inside their hold; wait until activates_at has passed for every row, then reverse';
  END IF;
END $$;

-- A held row whose hold has passed but that no read has promoted yet is active: promote it before the column goes.
UPDATE "pay"."merchant_payout_destinations"
   SET "verified" = true, "updated_at" = now()
 WHERE "verified" = false AND "activates_at" IS NOT NULL AND "activates_at" <= now();

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "activates_at";
