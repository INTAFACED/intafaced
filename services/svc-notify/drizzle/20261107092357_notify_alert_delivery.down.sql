-- Reversal of 20261107092357_notify_alert_delivery.sql. Every alert reaches the in-app inbox alone again; the webhook log is gone.
DROP TABLE IF EXISTS "notify"."alert_webhook_attempts";
DROP TABLE IF EXISTS "notify"."alert_channels";
