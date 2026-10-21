-- intafaced:destructive — reversal of 0119_pay_kyb_documents.sql
--
-- Drops the uploaded business documents (ciphertext) and the owner's upload rules. Stored rows go with the tables.

DROP TABLE IF EXISTS "pay"."kyb_documents";
DROP TABLE IF EXISTS "pay"."kyb_upload_rules";
