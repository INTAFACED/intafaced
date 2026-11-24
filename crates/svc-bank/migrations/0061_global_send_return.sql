-- J-bank-04 #7 (BK-xfer-09): a global send that left can come back from the rail (bounced back) and then be refunded to
-- the sender's own space, once; and its customer can ask for it back when it went to the wrong person (a recall).
ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_status_ck";
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_status_ck"
  CHECK ("status" IN ('submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed', 'cancelled', 'returned', 'refunded'));
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "return_ref" text;
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "returned_by" text;
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "returned_at" timestamptz;
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "refund_operator_id" text;
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "refunded_at" timestamptz;
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "recall_reason" text;
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "recall_requested_at" timestamptz;
-- A return is recorded only on a send with its forward entry, and names the rail's reference and who recorded it; a
-- refund names who approved it, and only a returned send is refunded.
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_return_ck" CHECK (
  ("status" IN ('returned', 'refunded')) = ("return_ref" IS NOT NULL AND "returned_by" IS NOT NULL AND "returned_at" IS NOT NULL)
  AND ("status" NOT IN ('returned', 'refunded') OR "ledger_tx_id" IS NOT NULL)
  AND ("status" = 'refunded') = ("refund_operator_id" IS NOT NULL AND "refunded_at" IS NOT NULL)
);
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_recall_ck" CHECK (
  ("recall_reason" IS NULL) = ("recall_requested_at" IS NULL)
  AND ("recall_reason" IS NULL OR char_length("recall_reason") BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS "global_sends_return_ref_uq" ON "bank"."global_sends" ("return_ref") WHERE "return_ref" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "global_sends_recall_idx" ON "bank"."global_sends" ("recall_requested_at")
  WHERE "recall_requested_at" IS NOT NULL;
