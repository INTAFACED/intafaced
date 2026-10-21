-- svc-notify · C-alerts-scan-02 alert trigger log
-- Reversal: 0021_notify_alert_triggers.down.sql
--
-- One row each time an alert fired. An alert fires once, so alert_id is the key and recording is idempotent. No foreign key to
-- price_alerts: the history stays when the person deletes the alert, and ages out under the owner-set retention.

CREATE TABLE IF NOT EXISTS "notify"."alert_triggers" (
  "alert_id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "market_id" text NOT NULL,
  "condition" text NOT NULL,
  "target_price" text NOT NULL,
  "mark_price" text NOT NULL,
  "fired_at" timestamptz NOT NULL,
  "notification_id" text
);
CREATE INDEX IF NOT EXISTS "alert_triggers_user_fired_idx" ON "notify"."alert_triggers" ("user_id", "fired_at" DESC);
CREATE INDEX IF NOT EXISTS "alert_triggers_fired_idx" ON "notify"."alert_triggers" ("fired_at");
