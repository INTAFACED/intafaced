-- Reversal of 0019_notify_alert_extra_conditions.sql. Added conditions are dropped; the main condition of each alert stays.
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_extra_conditions_ck";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "extra_conditions";
