-- intafaced:destructive — reversal of 20261024065309_pay_kyb_document_reviews.sql
--
-- Drops who reviewed each document and who opened each file. Verdicts already written onto uploads stay.

DROP TRIGGER IF EXISTS "kyb_documents_verdict_only_trg" ON "pay"."kyb_documents";
DROP FUNCTION IF EXISTS "pay"."kyb_documents_verdict_only"();
DROP TRIGGER IF EXISTS "kyb_document_reads_append_only_trg" ON "pay"."kyb_document_reads";
DROP TRIGGER IF EXISTS "kyb_document_reviews_append_only_trg" ON "pay"."kyb_document_reviews";
DROP FUNCTION IF EXISTS "pay"."kyb_document_review_append_only"();
DROP TABLE IF EXISTS "pay"."kyb_document_reads";
DROP TABLE IF EXISTS "pay"."kyb_document_reviews";
