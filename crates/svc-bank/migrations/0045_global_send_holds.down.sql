DROP TABLE IF EXISTS "bank"."global_incoming_links";
DROP TABLE IF EXISTS "bank"."global_send_holds";
-- intafaced:destructive restores the earlier status check; a held row must be released or failed first
ALTER TABLE "bank"."global_sends" DROP CONSTRAINT IF EXISTS "global_sends_status_ck";
ALTER TABLE "bank"."global_sends" ADD CONSTRAINT "global_sends_status_ck"
  CHECK ("status" IN ('submitted', 'sent', 'on_the_way', 'arrived', 'failed'));
