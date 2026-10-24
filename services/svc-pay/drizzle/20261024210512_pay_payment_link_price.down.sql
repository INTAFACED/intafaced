-- intafaced:destructive — reversal of 20261024210512_pay_payment_link_price.sql
--
-- Forgets which catalogue price each payment link was made from. The links keep their amount and asset.

DROP TRIGGER IF EXISTS "payment_links_price_kept_trg" ON "pay"."payment_links";
DROP FUNCTION IF EXISTS "pay"."payment_links_price_kept"();
DROP INDEX IF EXISTS "pay"."payment_links_price_idx";
ALTER TABLE "pay"."payment_links" DROP COLUMN IF EXISTS "price_id";
