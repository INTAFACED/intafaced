-- intafaced:destructive — reversal of 0088_pay_destination_default_invoice_lines.sql
--
-- Drops invoice lines, the due date, the customer email, the destination
-- default flag, and the tier visibility flag. Header invoice amounts and
-- destination refs stay.

DROP TRIGGER IF EXISTS "merchant_invoice_lines_match_total_trg" ON "pay"."merchant_invoice_lines";
DROP FUNCTION IF EXISTS "pay"."merchant_invoice_lines_match_total"();
DROP TABLE IF EXISTS "pay"."merchant_invoice_lines";

ALTER TABLE "pay"."merchant_invoices"
  DROP CONSTRAINT IF EXISTS "merchant_invoices_email_ck";

ALTER TABLE "pay"."merchant_invoices"
  DROP COLUMN IF EXISTS "customer_email",
  DROP COLUMN IF EXISTS "due_at";

DROP INDEX IF EXISTS "pay"."merchant_payout_destinations_one_default_idx";

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "is_default";

ALTER TABLE "pay"."control_tiers"
  DROP COLUMN IF EXISTS "merchant_visible";
