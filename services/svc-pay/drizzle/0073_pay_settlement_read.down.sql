-- intafaced:destructive — reversal of 0073_pay_settlement_read.sql
--
-- Drops the settlement timestamp columns and the list indexes. The timestamps
-- are copies of transitions already recorded as status changes; dropping them
-- does not move ledger value.

DROP INDEX IF EXISTS "pay"."payment_events_settlement_included_idx";
DROP INDEX IF EXISTS "pay"."payments_merchant_list_idx";
DROP INDEX IF EXISTS "pay"."settlements_merchant_list_idx";
ALTER TABLE "pay"."settlements" DROP CONSTRAINT IF EXISTS "settlements_failure_code_ck";
ALTER TABLE "pay"."settlements" DROP COLUMN IF EXISTS "failure_code";
ALTER TABLE "pay"."settlements" DROP COLUMN IF EXISTS "failed_at";
ALTER TABLE "pay"."settlements" DROP COLUMN IF EXISTS "settled_at";
ALTER TABLE "pay"."settlements" DROP COLUMN IF EXISTS "sent_at";
