-- intafaced:destructive — reversal of 0068_pay_operator_merchant_notes.sql
--
-- Drops operator notes, tags and flags on merchants. Merchants never saw them;
-- the operator history of why a merchant was flagged is lost.

DROP TRIGGER IF EXISTS "operator_merchant_notes_guard_trg" ON "pay"."operator_merchant_notes";
DROP TABLE IF EXISTS "pay"."operator_merchant_notes";
DROP FUNCTION IF EXISTS "pay"."operator_merchant_notes_guard"();
