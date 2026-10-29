-- Reverses 20261027070000_kyc_poa_submissions.sql.
-- intafaced:destructive drops every proof-of-address submission row; the files stay in kyc_documents.
DROP TABLE IF EXISTS "identity"."kyc_poa_submissions";
