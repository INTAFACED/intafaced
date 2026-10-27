-- Reverses 20261027051000_kyc_capabilities.sql.
-- intafaced:destructive drops every KYC capability and its history; kyc_records, cases and every granted level stay.
DROP TABLE IF EXISTS "identity"."kyc_capability_events";
DROP TABLE IF EXISTS "identity"."kyc_capabilities";
