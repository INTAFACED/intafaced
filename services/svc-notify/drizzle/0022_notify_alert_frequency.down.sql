-- Reversal of 0022_notify_alert_frequency.sql. Every alert becomes one-shot again and the log of fires is dropped; alert_triggers
-- still holds the first fire of every alert that fired before this migration. The alerts themselves are untouched.
DROP TABLE IF EXISTS "notify"."alert_fires";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "last_fired_at";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "fire_count";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "frequency";
