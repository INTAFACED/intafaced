-- intafaced:destructive turns cancelled global sends into failed ones and their holds into released ones; nothing was posted for either
UPDATE "bank"."global_send_holds" SET "state" = 'released' WHERE "state" = 'cancelled';
DROP INDEX IF EXISTS "bank"."global_send_holds_open_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "global_send_holds_open_uq"
  ON "bank"."global_send_holds" ("send_id") WHERE "state" <> 'released';
ALTER TABLE "bank"."global_send_holds" DROP CONSTRAINT IF EXISTS "global_send_holds_released_ck";
ALTER TABLE "bank"."global_send_holds" ADD CONSTRAINT "global_send_holds_released_ck"
  CHECK (("state" = 'released') = ("released_by" IS NOT NULL));
ALTER TABLE "bank"."global_send_holds" DROP CONSTRAINT IF EXISTS "global_send_holds_state_ck";
ALTER TABLE "bank"."global_send_holds" ADD CONSTRAINT "global_send_holds_state_ck"
  CHECK ("state" IN ('requested', 'under_review', 'released'));
ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_cancelled_ck";
UPDATE "bank"."global_sends" SET "status" = 'failed', "failure_code" = 'bank.global_send_cancelled' WHERE "status" = 'cancelled';
ALTER TABLE "bank"."global_sends" DROP COLUMN IF EXISTS "cancelled_by";
ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_status_ck";
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_status_ck"
  CHECK ("status" IN ('submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed'));
