-- Cash out that pays out (BK-xfer-08, BK-xfer-09, J-bank-03 #4/#5): a cash-out request a banking partner takes.
--
-- A request the bank cannot send is still kept `refused` with its code, holding and posting nothing, as before. One the
-- partner takes is `processing`: the amount was held under the request's own key (`withdraw.hold:cash-out:<id>`) when the
-- person confirmed. The partner then answers once. Paid: `completed`, the hold settled to the payout rail once. Not paid:
-- `failed` with the partner's reason, the hold given back once. A payout the receiving bank later sends back, in full or in
-- part, is `returned` with what came back, credited once from the payout rail (`deposit:<rail>:cash-out-return:<id>`).
-- Every amount column is a record of one request or one return, never a balance: the ledger is the only answer to how
-- much anyone holds. The fee and what arrives are the partner's own figures for this request, copied once.
--
-- Reversal: 20261024072646_cash_out_payouts.down.sql

ALTER TABLE "bank"."cash_out_requests"
  DROP CONSTRAINT IF EXISTS "cash_out_requests_status_ck",
  ADD COLUMN IF NOT EXISTS "payout_rail" text,
  ADD COLUMN IF NOT EXISTS "payout_ref" text,
  ADD COLUMN IF NOT EXISTS "fee" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "receive_amount" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "receive_currency" text,
  ADD COLUMN IF NOT EXISTS "hold_ledger_tx_id" text,
  ADD COLUMN IF NOT EXISTS "settle_ledger_tx_id" text,
  ADD COLUMN IF NOT EXISTS "reverse_ledger_tx_id" text,
  ADD COLUMN IF NOT EXISTS "failure_code" text,
  ADD COLUMN IF NOT EXISTS "returned_amount" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "return_ledger_tx_id" text,
  ADD COLUMN IF NOT EXISTS "completed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "failed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "returned_at" timestamptz,
  ADD CONSTRAINT "cash_out_requests_status_ck" CHECK (
    ("status" = 'refused' AND "refusal_code" IS NOT NULL AND "payout_rail" IS NULL AND "hold_ledger_tx_id" IS NULL)
    OR ("status" = 'processing' AND "refusal_code" IS NULL AND "payout_rail" IS NOT NULL AND "settle_ledger_tx_id" IS NULL
        AND "reverse_ledger_tx_id" IS NULL)
    OR ("status" = 'completed' AND "payout_rail" IS NOT NULL AND "hold_ledger_tx_id" IS NOT NULL
        AND "settle_ledger_tx_id" IS NOT NULL AND "completed_at" IS NOT NULL AND "returned_amount" IS NULL)
    OR ("status" = 'failed' AND "payout_rail" IS NOT NULL AND "failure_code" IS NOT NULL AND "settle_ledger_tx_id" IS NULL
        AND "failed_at" IS NOT NULL)
    OR ("status" = 'returned' AND "settle_ledger_tx_id" IS NOT NULL AND "returned_amount" IS NOT NULL
        AND "return_ledger_tx_id" IS NOT NULL AND "failure_code" IS NOT NULL AND "returned_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "cash_out_requests_returned_ck" CHECK (
    "returned_amount" IS NULL OR ("returned_amount" > 0 AND "returned_amount" <= "amount")
  ),
  ADD CONSTRAINT "cash_out_requests_quote_ck" CHECK (
    ("fee" IS NULL AND "receive_amount" IS NULL AND "receive_currency" IS NULL)
    OR ("fee" >= 0 AND "receive_amount" > 0 AND "receive_currency" ~ '^[A-Z]{3,16}$')
  );

-- One payout reference names one request.
CREATE UNIQUE INDEX IF NOT EXISTS "cash_out_requests_payout_ref_idx"
  ON "bank"."cash_out_requests" ("payout_rail", "payout_ref") WHERE "payout_ref" IS NOT NULL;
-- What the partner has not answered yet, oldest first.
CREATE INDEX IF NOT EXISTS "cash_out_requests_processing_idx"
  ON "bank"."cash_out_requests" ("created_at") WHERE "status" = 'processing';
