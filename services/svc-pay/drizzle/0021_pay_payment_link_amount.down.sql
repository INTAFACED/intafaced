-- intafaced:destructive — reversal of 0021_pay_payment_link_amount.sql
--
-- Drops the price check and widens amount back to numeric(40,18).
-- Does not UPDATE stored amounts.

ALTER TABLE "pay"."payment_links" DROP CONSTRAINT IF EXISTS "payment_links_amount_price_ck";
ALTER TABLE "pay"."payment_links"
  ALTER COLUMN "amount" TYPE numeric(40, 18);
