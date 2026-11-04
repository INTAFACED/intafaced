-- Add money that is paid (J-bank-02 #3, #5): an opened request moves on to `pending` when the payer approved it on the
-- partner's page, and to `credited` once the partner said the money arrived and the ledger's deposit recipe credited it.
--
-- The request keeps when each step happened, so the person can watch it from created to credited. A credited request
-- names the ledger transaction and the amount it credited, which is the quote's receive amount and never anything else.
-- This table is still a record, not a balance: money reaches the balance only through the deposit recipe, whose
-- business key (`deposit:<rail>:add-money:<request id>`) makes a second "paid" credit nothing.
--
-- Reversal: 20261104103406_add_money_credit.down.sql

ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "opened_at" timestamptz;
ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "pending_at" timestamptz;
ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "credited_at" timestamptz;
ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "credited_amount" numeric(38, 18);
ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "ledger_tx_id" text;

-- A request that opened before this migration opened when its payment was opened: that time is kept, never a guess.
UPDATE "bank"."add_money_requests" r
   SET "opened_at" = o."created_at"
  FROM "bank"."customer_onramps" o
 WHERE r."onramp_id" = o."id" AND r."opened_at" IS NULL;

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
    ("status" = 'credited' AND "credited_at" IS NOT NULL AND "ledger_tx_id" IS NOT NULL AND "credited_amount" > 0)
    OR ("status" <> 'credited' AND "credited_at" IS NULL AND "ledger_tx_id" IS NULL AND "credited_amount" IS NULL)
  )
);
