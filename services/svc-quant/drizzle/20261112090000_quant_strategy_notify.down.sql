-- Reverses the strategy notify migration (AL-live-06, AL-alerts-01). Every channel setting, alert and announced fill is lost.
DROP TRIGGER IF EXISTS "alert_fills_insert_only" ON "quant"."alert_fills";
DROP TRIGGER IF EXISTS "strategy_alerts_insert_only" ON "quant"."strategy_alerts";
DROP FUNCTION IF EXISTS "quant"."reject_alert_rewrite"();
DROP TABLE IF EXISTS "quant"."alert_fills";
DROP TABLE IF EXISTS "quant"."strategy_alerts";
DROP TABLE IF EXISTS "quant"."strategy_notify";
