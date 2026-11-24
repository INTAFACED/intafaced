-- Refuses, changing nothing, while any request was credited by the partner: such a row names no ledger transaction, so
-- the old check re-added below could not hold it, and dropping the column would erase what the partner did.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."add_money_requests" WHERE "partner_pay_in_ref" IS NOT NULL) THEN
    RAISE EXCEPTION 'add_money_partner_credit down: partner-credited requests exist; nothing was changed';
  END IF;
END
$$;

ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_steps_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_steps_ck" CHECK (
  ("status" <> 'pending' OR "pending_at" IS NOT NULL)
  AND (
    ("status" = 'credited' AND "credited_at" IS NOT NULL AND "ledger_tx_id" IS NOT NULL AND "credited_amount" > 0)
    OR ("status" <> 'credited' AND "credited_at" IS NULL AND "ledger_tx_id" IS NULL AND "credited_amount" IS NULL)
  )
);
ALTER TABLE "bank"."add_money_requests" DROP COLUMN IF EXISTS "partner_pay_in_ref";
