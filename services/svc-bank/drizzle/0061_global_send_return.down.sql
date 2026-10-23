-- intafaced:destructive forgets returns and recall requests on global sends; a returned send (nothing refunded) reads as sent again, and a refunded one as failed with bank.global_send_refunded, its forward entry and refund both kept in the ledger by key (the row loses its ledger id, as every failed send has none)
DROP INDEX IF EXISTS "bank"."global_sends_recall_idx";
DROP INDEX IF EXISTS "bank"."global_sends_return_ref_uq";
ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_recall_ck";
ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_return_ck";
UPDATE "bank"."global_sends" SET "status" = 'failed', "failure_code" = 'bank.global_send_refunded', "ledger_tx_id" = NULL WHERE "status" = 'refunded';
UPDATE "bank"."global_sends" SET "status" = 'sent' WHERE "status" = 'returned';
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "recall_requested_at";
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "recall_reason";
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "refunded_at";
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "refunded_by";
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "returned_at";
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "returned_by";
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "return_ref";
ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_status_ck";
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_status_ck"
  CHECK ("status" IN ('submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed', 'cancelled'));
