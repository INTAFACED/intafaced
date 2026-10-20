-- svc-notify · C-alerts-scan-01b multi-condition price alerts
-- Reversal: 0019_notify_alert_extra_conditions.down.sql
--
-- extra_conditions: further level conditions on the same market, as a JSON array of {condition, targetPrice}. The alert fires
-- only when its main condition and every one of these holds. Existing rows have none.

ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "extra_conditions" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_extra_conditions_ck";
ALTER TABLE "notify"."price_alerts" ADD CONSTRAINT "price_alerts_extra_conditions_ck"
  CHECK (jsonb_typeof("extra_conditions") = 'array');
