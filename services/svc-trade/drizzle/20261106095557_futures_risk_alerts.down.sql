-- Reverse 20261106095557_futures_risk_alerts.sql
DROP TABLE IF EXISTS "trade"."futures_risk_alert_crossings";
DROP TABLE IF EXISTS "trade"."futures_risk_alert_levels";
ALTER TABLE "trade"."position_margin_calls" DROP COLUMN IF EXISTS "announced_at";
