-- svc-notify · C-alerts-scan-03b burst auto-stop
-- Reversal: 0026_notify_alert_burst.down.sql
--
-- A repeating alert that triggers more than the owner's count inside the owner's window is stopped with a reason. The window is
-- counted per alert from its first trigger in the window: burst_started_at and burst_count. stop_reason says why an alert is
-- stopped ('burst'); a pause by the person leaves it null.

ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "stop_reason" text;
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "burst_started_at" timestamptz;
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "burst_count" integer NOT NULL DEFAULT 0;
