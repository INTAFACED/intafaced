-- Reverses 20261025025914_kyc_cases.sql.
-- intafaced:destructive drops every KYC case, its history and reject reasons; kyc_records and every granted level stay.
DROP TABLE IF EXISTS "identity"."kyc_case_events";
DROP TABLE IF EXISTS "identity"."kyc_cases";
