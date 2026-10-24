-- intafaced:destructive — reversal of 0132_pay_payment_link_share.sql
--
-- Drops the deactivation message and the confirmation columns. Link rows stay.
-- No ledger data is touched.

ALTER TABLE "pay"."payment_links" DROP CONSTRAINT IF EXISTS "payment_links_confirmation_ck";
ALTER TABLE "pay"."payment_links" DROP CONSTRAINT IF EXISTS "payment_links_inactive_message_ck";
ALTER TABLE "pay"."payment_links" DROP COLUMN IF EXISTS "confirmation_url";
ALTER TABLE "pay"."payment_links" DROP COLUMN IF EXISTS "confirmation_message";
ALTER TABLE "pay"."payment_links" DROP COLUMN IF EXISTS "inactive_message";
