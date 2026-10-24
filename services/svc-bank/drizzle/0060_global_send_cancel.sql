-- J-bank-04 #6 (BK-xfer-08): a global send on hold can be cancelled, by its customer or by the owner's auto-cancel window.
-- Only a held send with nothing posted can be: a cancelled send never has a ledger transaction.
ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_status_ck";
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_status_ck"
  CHECK ("status" IN ('submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed', 'cancelled'));
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "cancelled_by" text;
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_cancelled_ck" CHECK (
  ("status" = 'cancelled') = ("cancelled_by" IS NOT NULL)
  AND ("cancelled_by" IS NULL OR "cancelled_by" IN ('customer', 'auto'))
  AND ("status" <> 'cancelled' OR "ledger_tx_id" IS NULL)
);
ALTER TABLE "bank"."global_send_holds" DROP CONSTRAINT IF EXISTS "global_send_holds_state_ck";
ALTER TABLE "bank"."global_send_holds" ADD CONSTRAINT "global_send_holds_state_ck"
  CHECK ("state" IN ('requested', 'under_review', 'released', 'cancelled'));
-- A cancelled hold is closed like a released one: it names who closed it, and it no longer counts as the send's open hold.
ALTER TABLE "bank"."global_send_holds" DROP CONSTRAINT IF EXISTS "global_send_holds_released_ck";
ALTER TABLE "bank"."global_send_holds" ADD CONSTRAINT "global_send_holds_released_ck"
  CHECK (("state" IN ('released', 'cancelled')) = ("released_by" IS NOT NULL));
DROP INDEX IF EXISTS "bank"."global_send_holds_open_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "global_send_holds_open_uq"
  ON "bank"."global_send_holds" ("send_id") WHERE "state" IN ('requested', 'under_review');
