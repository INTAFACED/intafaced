-- intafaced:destructive — reversal of 20261029210751_pay_payment_views_unmask.sql
--
-- Drops every saved payments view and the audit of unmasked payment details. No payment, invoice or ledger row changes.

DROP TABLE IF EXISTS "pay"."payment_unmask_reads";
DROP TABLE IF EXISTS "pay"."payment_views";
