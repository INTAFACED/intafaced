-- intafaced:destructive — reversal of 0084_pay_merchant_invoices.sql
--
-- Drops standalone invoices and their idempotency journal. Subscription
-- executions and payment links are not dropped; a link created for an invoice
-- remains a normal payment link.

DROP TRIGGER IF EXISTS "merchant_invoice_actions_append_only_trg" ON "pay"."merchant_invoice_actions";
DROP TABLE IF EXISTS "pay"."merchant_invoice_actions";
DROP TABLE IF EXISTS "pay"."merchant_invoices";
DROP FUNCTION IF EXISTS "pay"."merchant_invoice_actions_append_only"();
