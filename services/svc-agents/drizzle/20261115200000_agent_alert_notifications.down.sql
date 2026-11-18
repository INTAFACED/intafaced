-- Reverses 20261115200000_agent_alert_notifications.sql. Alerts already handed over read as pending again: the record
-- of the hand-off goes with the column.
DROP TABLE IF EXISTS "agents"."agent_alert_settings";
DROP INDEX IF EXISTS "agents"."agent_alerts_pending_idx";
ALTER TABLE "agents"."agent_alerts" DROP CONSTRAINT IF EXISTS "agent_alerts_handed_off_check";
ALTER TABLE "agents"."agent_alerts" DROP CONSTRAINT IF EXISTS "agent_alerts_delivery_check";
UPDATE "agents"."agent_alerts" SET "delivery" = 'pending' WHERE "delivery" = 'handed_off';
ALTER TABLE "agents"."agent_alerts" ADD CONSTRAINT "agent_alerts_delivery_check" CHECK ("delivery" IN ('pending', 'sent'));
ALTER TABLE "agents"."agent_alerts" DROP COLUMN IF EXISTS "handed_off_at";
