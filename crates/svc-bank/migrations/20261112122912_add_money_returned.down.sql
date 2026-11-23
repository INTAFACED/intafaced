-- Refuses, changing nothing, while any request was returned: the old checks re-added below have no `returned` status,
-- and dropping the columns would erase that the credit was taken back.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."add_money_requests" WHERE "status" = 'returned' OR "returned_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'add_money_returned down: returned requests exist; nothing was changed';
  END IF;
END
$$;

ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_status_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_status_ck" CHECK (
  ("status" = 'opening' AND "refusal_code" IS NULL AND "onramp_id" IS NULL AND "quote_id" IS NOT NULL)
  OR ("status" = 'refused' AND "refusal_code" IS NOT NULL AND "onramp_id" IS NULL)
  OR ("status" IN ('opened', 'pending', 'credited') AND "refusal_code" IS NULL AND "onramp_id" IS NOT NULL AND "quote_id" IS NOT NULL)
);
ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_steps_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_steps_ck" CHECK (
  ("status" <> 'pending' OR "pending_at" IS NOT NULL)
  AND (
    (
      "status" = 'credited' AND "credited_at" IS NOT NULL AND "credited_amount" > 0
      AND (("ledger_tx_id" IS NOT NULL) <> ("partner_pay_in_ref" IS NOT NULL))
    )
    OR (
      "status" <> 'credited' AND "credited_at" IS NULL AND "ledger_tx_id" IS NULL AND "credited_amount" IS NULL
      AND "partner_pay_in_ref" IS NULL
    )
  )
);
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "return_ref";
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "returned_at";
