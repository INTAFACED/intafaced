-- Reverses 0063_api_key_operator_revocations.sql. The operator revoke audit rows are dropped; revoked keys stay revoked.
DROP TABLE IF EXISTS "identity"."api_key_operator_revocations";
