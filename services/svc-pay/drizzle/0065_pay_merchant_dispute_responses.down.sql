-- intafaced:destructive — reversal of 0065_pay_merchant_dispute_responses.sql
--
-- Drops the merchant's evidence metadata and recorded dispute decisions. The
-- dispute cases themselves live in src/fraud and are not touched.

DROP TRIGGER IF EXISTS "merchant_dispute_responses_append_only_trg" ON "pay"."merchant_dispute_responses";
DROP TRIGGER IF EXISTS "merchant_dispute_evidence_append_only_trg" ON "pay"."merchant_dispute_evidence";
DROP TABLE IF EXISTS "pay"."merchant_dispute_responses";
DROP TABLE IF EXISTS "pay"."merchant_dispute_evidence";
DROP FUNCTION IF EXISTS "pay"."merchant_dispute_ops_append_only"();
