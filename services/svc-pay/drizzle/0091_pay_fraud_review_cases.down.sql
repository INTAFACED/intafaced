-- intafaced:destructive — reversal of 0091_pay_fraud_review_cases.sql
--
-- Drops the fraud review case and its append-only decisions. Stored rows go
-- with the tables.

DROP TRIGGER IF EXISTS "fraud_review_decisions_append_only_truncate_trg" ON "pay"."fraud_review_decisions";
DROP TRIGGER IF EXISTS "fraud_review_decisions_append_only_trg" ON "pay"."fraud_review_decisions";
DROP FUNCTION IF EXISTS "pay"."fraud_review_decisions_append_only"();
DROP TABLE IF EXISTS "pay"."fraud_review_decisions";
DROP TABLE IF EXISTS "pay"."fraud_review_cases";
