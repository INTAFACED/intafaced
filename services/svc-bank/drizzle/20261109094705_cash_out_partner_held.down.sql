-- Reversal of the partner-held cash-out columns and the cancelled status. Run only once no request is partner-held or
-- cancelled: such a row is a record of a partner move, and dropping its columns would lose which move it made.
DROP INDEX IF EXISTS "bank"."cash_out_requests_partner_move_idx";
ALTER TABLE "bank"."cash_out_requests"
  DROP CONSTRAINT IF EXISTS "cash_out_requests_status_ck",
  DROP CONSTRAINT IF EXISTS "cash_out_requests_one_book_ck",
  DROP COLUMN IF EXISTS "cancelled_at",
  DROP COLUMN IF EXISTS "partner_return_move_id",
  DROP COLUMN IF EXISTS "partner_back_move_id",
  DROP COLUMN IF EXISTS "partner_move_id",
  DROP COLUMN IF EXISTS "custodian",
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
  );
