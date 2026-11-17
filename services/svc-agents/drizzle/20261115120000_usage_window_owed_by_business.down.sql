-- Reverses 20261115120000_usage_window_owed_by_business.sql.
ALTER TABLE "agents"."usage_windows" DROP COLUMN IF EXISTS "owed_by_business";
