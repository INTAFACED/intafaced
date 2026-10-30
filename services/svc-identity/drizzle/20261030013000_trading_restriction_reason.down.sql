-- Reverses 20261030013000_trading_restriction_reason.sql.
ALTER TABLE "identity"."trading_restrictions" DROP COLUMN IF EXISTS "reason_code";
