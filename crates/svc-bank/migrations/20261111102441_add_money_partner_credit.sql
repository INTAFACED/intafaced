-- Add money credited by the partner (J-wallet-01 #3; OWNER 226): for a person whose bank money the partner holds, the
-- partner itself credits a paid purchase to their main balance at the partner, and the ledger posts nothing. The request
-- then names the partner's pay-in reference instead of a ledger transaction. A credited request names exactly one of the
-- two; one not credited names neither.
--
-- Reversal: 20261111102441_add_money_partner_credit.down.sql

ALTER TABLE "bank"."add_money_requests" ADD COLUMN IF NOT EXISTS "partner_pay_in_ref" text;

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
