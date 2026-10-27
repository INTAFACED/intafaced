-- intafaced:destructive — reversal of the returned-withdrawal credit.
--
-- Drops the approvals and postings of returned withdrawals and the customer reason code. A posted credit stays in the
-- ledger, which never forgets it; this is for CI proof of reversibility and a database that credited no real return.

DROP TRIGGER IF EXISTS "withdrawal_return_postings_append_only_trg" ON "pay"."withdrawal_return_postings";
DROP TRIGGER IF EXISTS "withdrawal_return_credits_append_only_trg" ON "pay"."withdrawal_return_credits";
DROP TABLE IF EXISTS "pay"."withdrawal_return_postings";
DROP TABLE IF EXISTS "pay"."withdrawal_return_credits";
ALTER TABLE "pay"."withdrawal_returns" DROP CONSTRAINT IF EXISTS "withdrawal_returns_reason_code_ck";
ALTER TABLE "pay"."withdrawal_returns" DROP COLUMN IF EXISTS "reason_code";
