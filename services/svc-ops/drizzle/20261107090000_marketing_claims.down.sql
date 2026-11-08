-- Reverses 20261107090000_marketing_claims.sql.
DROP TRIGGER IF EXISTS marketing_claim_log_append_only ON ops.marketing_claim_log;
DROP TABLE IF EXISTS ops.marketing_claim_log;
DROP TABLE IF EXISTS ops.marketing_claims;
