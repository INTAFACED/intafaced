-- Reversal of the cash-out payout columns. Run only once no request is past `refused`: a processing, completed, failed or
-- returned request is a record of money that moved, and dropping its columns would lose which ledger entries it made.
DROP INDEX IF EXISTS "bank"."cash_out_requests_processing_idx";
DROP INDEX IF EXISTS "bank"."cash_out_requests_payout_ref_idx";
ALTER TABLE "bank"."cash_out_requests"
  DROP CONSTRAINT IF EXISTS "cash_out_requests_quote_ck",
  DROP CONSTRAINT IF EXISTS "cash_out_requests_returned_ck",
  DROP CONSTRAINT IF EXISTS "cash_out_requests_status_ck",
  DROP COLUMN IF EXISTS "returned_at",
  DROP COLUMN IF EXISTS "failed_at",
  DROP COLUMN IF EXISTS "completed_at",
  DROP COLUMN IF EXISTS "return_ledger_tx_id",
  DROP COLUMN IF EXISTS "returned_amount",
  DROP COLUMN IF EXISTS "failure_code",
  DROP COLUMN IF EXISTS "reverse_ledger_tx_id",
  DROP COLUMN IF EXISTS "settle_ledger_tx_id",
  DROP COLUMN IF EXISTS "hold_ledger_tx_id",
  DROP COLUMN IF EXISTS "receive_currency",
  DROP COLUMN IF EXISTS "receive_amount",
  DROP COLUMN IF EXISTS "fee",
  DROP COLUMN IF EXISTS "payout_ref",
  DROP COLUMN IF EXISTS "payout_rail",
  ADD CONSTRAINT "cash_out_requests_status_ck" CHECK ("status" = 'refused' AND "refusal_code" IS NOT NULL);
