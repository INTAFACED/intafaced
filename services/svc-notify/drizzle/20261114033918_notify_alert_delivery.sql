-- svc-notify · J-charts-desk-10 alert delivery: channels per alert and the webhook adapter
-- Reversal: 20261114033918_notify_alert_delivery.down.sql
--
-- `channels` is the out-of-app channels the person chose for one alert (`email`, `push`). The in-app row is always written.
-- NULL is an alert made before the choice existed: it follows the person's notification settings, as every alert did then.
-- `webhook_url` is the person's own endpoint, checked when it is saved (https, an owner-allowed port, no private address)
-- and again when it is sent to.
--
-- `alert_webhook_deliveries` is one row per alert firing that has a webhook: the body sent, each attempt with its HTTP status
-- or connection error, and when the next attempt is due under the owner's retry schedule. (alert_id, seq) is the firing, so a
-- firing replayed after a crash finds its row and posts nothing new; `lease_until` keeps two workers off the same row.

ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "channels" jsonb;
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "webhook_url" text;

CREATE TABLE IF NOT EXISTS "notify"."alert_webhook_deliveries" (
  "alert_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "user_id" text NOT NULL,
  "url" text NOT NULL,
  "body" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "next_attempt_at" timestamptz,
  "lease_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("alert_id", "seq"),
  CONSTRAINT "alert_webhook_deliveries_status_ck" CHECK ("status" IN ('pending', 'delivered', 'failed')),
  CONSTRAINT "alert_webhook_deliveries_due_ck" CHECK (("status" = 'pending') = ("next_attempt_at" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "alert_webhook_deliveries_due_idx"
  ON "notify"."alert_webhook_deliveries" ("next_attempt_at") WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "alert_webhook_deliveries_user_idx" ON "notify"."alert_webhook_deliveries" ("user_id", "created_at" DESC);
