-- Reverses 20261107072813_api_rate_limit_requests.sql.
DROP TABLE IF EXISTS "identity"."api_limit_audit";
DROP TABLE IF EXISTS "identity"."api_limit_requests";
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_rate_refill_granted_ck";
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "rate_refill_per_minute_granted";
