-- Reverses 0073_api_key_exposure_reports.sql. Report rows are dropped; keys revoked by a report stay revoked.
DROP TABLE IF EXISTS "identity"."api_key_exposure_reports";
