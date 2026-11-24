-- svc-agents · alert notifications: an alert handed to svc-notify, and an operator's switch to take them down
-- (J-agents-16 #3; AG-analytics-02)
-- Reversal: 20261115200000_agent_alert_notifications.down.sql
--
-- An alert is kept whether or not it is delivered. It is `pending` until svc-agents hands it to notifications (svc-notify,
-- by the `agentAlertFired` event), then `handed_off` with the time it was handed over. While an operator has taken alert
-- notifications down (`agent_alert_settings`), alerts stay `pending`, and every pending one is handed over when they are
-- back. No row in `agent_alert_settings` is on. Nothing here is a balance and no value moves.

ALTER TABLE "agents"."agent_alerts" ADD COLUMN IF NOT EXISTS "handed_off_at" timestamptz;
-- Until now nothing wrote a delivery but `pending`: the old 'sent' value was never used.
ALTER TABLE "agents"."agent_alerts" DROP CONSTRAINT IF EXISTS "agent_alerts_delivery_check";
ALTER TABLE "agents"."agent_alerts" ADD CONSTRAINT "agent_alerts_delivery_check" CHECK ("delivery" IN ('pending', 'handed_off'));
ALTER TABLE "agents"."agent_alerts" DROP CONSTRAINT IF EXISTS "agent_alerts_handed_off_check";
ALTER TABLE "agents"."agent_alerts" ADD CONSTRAINT "agent_alerts_handed_off_check"
  CHECK (("delivery" = 'handed_off') = ("handed_off_at" IS NOT NULL));
CREATE INDEX IF NOT EXISTS "agent_alerts_pending_idx" ON "agents"."agent_alerts" ("created_at") WHERE "delivery" = 'pending';

CREATE TABLE IF NOT EXISTS "agents"."agent_alert_settings" (
  "id"            boolean PRIMARY KEY DEFAULT true,
  "notifications" text NOT NULL,
  "set_by"        text NOT NULL,
  "set_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_alert_settings_one_row" CHECK ("id"),
  CONSTRAINT "agent_alert_settings_notifications_check" CHECK ("notifications" IN ('on', 'down'))
);
