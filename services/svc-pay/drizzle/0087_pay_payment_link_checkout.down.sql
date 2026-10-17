-- intafaced:destructive — reversal of 0087_pay_payment_link_checkout.sql
--
-- Drops the createLink idempotency journal and the stored checkout token.
-- Link rows stay. No ledger data is touched. After this reversal a link's
-- checkout address is not readable from the table.

DROP TABLE IF EXISTS "pay"."payment_link_create_idempotency";
DROP INDEX IF EXISTS "pay"."payment_links_checkout_token_uq";
ALTER TABLE "pay"."payment_links" DROP CONSTRAINT IF EXISTS "payment_links_checkout_token_ck";
ALTER TABLE "pay"."payment_links" DROP COLUMN IF EXISTS "checkout_token";
