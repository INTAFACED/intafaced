-- intafaced:destructive drops when each add-money step happened; it refuses while any request is pending or credited, so no credit record is lost
-- Reverses 20261104103406. Fails closed: a request that was approved or credited is something the person was shown, and
-- its credit is on the ledger, so this never folds one back into `opened`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."add_money_requests" WHERE "status" IN ('pending', 'credited')) THEN
    RAISE EXCEPTION 'add-money requests are pending or credited; 20261104103406 is not reversed';
  END IF;
END $$;

ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_steps_ck";
ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_status_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_status_ck" CHECK (
  ("status" = 'opening' AND "refusal_code" IS NULL AND "onramp_id" IS NULL AND "quote_id" IS NOT NULL)
  OR ("status" = 'refused' AND "refusal_code" IS NOT NULL AND "onramp_id" IS NULL)
  OR ("status" = 'opened' AND "refusal_code" IS NULL AND "onramp_id" IS NOT NULL AND "quote_id" IS NOT NULL)
);
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "ledger_tx_id";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "credited_amount";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "credited_at";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "pending_at";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "opened_at";
