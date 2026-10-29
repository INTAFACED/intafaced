-- Reverses 20261027080000_kyc_selfies.sql.
-- intafaced:destructive drops every selfie row and hand-off link; the captured frames stay in kyc_documents.
DROP TABLE IF EXISTS "identity"."kyc_selfie_handoffs";
DROP TABLE IF EXISTS "identity"."kyc_selfies";
