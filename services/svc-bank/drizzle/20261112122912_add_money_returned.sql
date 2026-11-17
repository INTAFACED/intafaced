-- Add money sent back (J-bank-02 #7): a credited payment the partner later says was returned is taken out once by the
-- partner that holds the person's bank money, and the ledger posts nothing (OWNER 226). The request then reads
-- `returned`, keeps what was credited and by whom, and names when it was returned and the partner's reference for the
-- return. Only a credited request can be returned. This table is a record, never a balance.
--
-- Reversal: 20261112122912_add_money_returned.down.sql

ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "returned_at" timestamptz;
ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "return_ref" text;

ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_status_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_status_ck" CHECK (
  ("status" = 'opening' AND "refusal_code" IS NULL AND "onramp_id" IS NULL AND "quote_id" IS NOT NULL)
  OR ("status" = 'refused' AND "refusal_code" IS NOT NULL AND "onramp_id" IS NULL)
  OR (
    "status" IN ('opened', 'pending', 'credited', 'returned')
    AND "refusal_code" IS NULL AND "onramp_id" IS NOT NULL AND "quote_id" IS NOT NULL
  )
);
ALTER TABLE "bank"."add_money_requests" DROP CONSTRAINT IF EXISTS "add_money_requests_steps_ck";
ALTER TABLE "bank"."add_money_requests" ADD CONSTRAINT "add_money_requests_steps_ck" CHECK (
  ("status" <> 'pending' OR "pending_at" IS NOT NULL)
  AND (
    (
      "status" IN ('credited', 'returned') AND "credited_at" IS NOT NULL AND "credited_amount" > 0
      AND (("ledger_tx_id" IS NOT NULL) <> ("partner_pay_in_ref" IS NOT NULL))
    )
    OR (
      "status" NOT IN ('credited', 'returned') AND "credited_at" IS NULL AND "ledger_tx_id" IS NULL
      AND "credited_amount" IS NULL AND "partner_pay_in_ref" IS NULL
    )
  )
  AND (("status" = 'returned') = ("returned_at" IS NOT NULL AND "return_ref" IS NOT NULL))
  AND ("status" = 'returned' OR ("returned_at" IS NULL AND "return_ref" IS NULL))
);
