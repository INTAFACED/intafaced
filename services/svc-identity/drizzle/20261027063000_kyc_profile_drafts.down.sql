-- Reverses 20261027063000_kyc_profile_drafts.sql.
-- intafaced:destructive drops every unsent guided-verification draft; sent requests, cases and documents stay.
DROP TABLE IF EXISTS "identity"."kyc_profile_drafts";
