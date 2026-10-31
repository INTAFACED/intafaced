-- Reversal of 0038_notify_alert_price_source.sql. Every alert is evaluated against the mark again; nothing else changes.
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_source_ck";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "source";
