-- Reversal of 0023_notify_alert_burst.sql. Alerts stopped by the burst rule stay stopped, without a reason; nothing else changes.
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "burst_count";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "burst_started_at";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "stop_reason";
