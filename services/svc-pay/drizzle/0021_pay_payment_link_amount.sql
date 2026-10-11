-- svc-pay · a payment link price has to fit a payment.
-- Reversal: 0021_pay_payment_link_amount.down.sql
--
-- 0002 stores payment_links.amount as numeric(40,18), nullable, with no
-- positive check, and currency as its own nullable text column. A link can
-- store zero, a negative price, an amount with no currency, or a magnitude
-- that will not fit numeric(38,18) on payments or checkout_sessions. Twenty
-- digits before the decimal and eighteen after is that column. 10^20 does
-- not fit.
--
-- 0002 is already applied. This migration does not UPDATE existing rows and
-- does not assign a price. Narrowing the type keeps every stored amount that
-- already fits and stops if one does not. The check is NOT VALID so a link
-- that already holds zero, a negative, or an amount with no currency is left
-- as it is. Inserts after this migration are refused.

ALTER TABLE "pay"."payment_links"
  ALTER COLUMN "amount" TYPE numeric(38, 18);

ALTER TABLE "pay"."payment_links" DROP CONSTRAINT IF EXISTS "payment_links_amount_price_ck";
ALTER TABLE "pay"."payment_links"
  ADD CONSTRAINT "payment_links_amount_price_ck"
  CHECK (
    "amount" IS NULL
    OR ("amount" > 0 AND "currency" IS NOT NULL)
  ) NOT VALID;
