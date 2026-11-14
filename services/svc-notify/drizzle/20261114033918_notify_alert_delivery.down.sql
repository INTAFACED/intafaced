-- Reversal of 20261114033918_notify_alert_delivery.sql. Alerts go back to following the person's notification settings, and
-- the webhook delivery record is dropped with the column that named the endpoint.
DROP TABLE IF EXISTS "notify"."alert_webhook_deliveries";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "webhook_url";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "channels";
