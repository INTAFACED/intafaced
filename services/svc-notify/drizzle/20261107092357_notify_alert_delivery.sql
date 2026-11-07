-- svc-notify · J-charts-desk-10 how an alert reaches the person
-- Reversal: 20261107092357_notify_alert_delivery.down.sql
--
-- alert_channels: the channels a price alert was set to (in-app always; popup, sound, email, push, webhook as chosen) and
-- its webhook URL. An alert with no row reaches the in-app inbox alone, as every alert did before this migration.
-- alert_webhook_attempts: one row per POST of one trigger of one alert, keyed (alert, trigger, attempt) so an attempt is
-- never sent twice; the log of status codes and errors is what the person reads as the webhook's diagnostics.

CREATE TABLE IF NOT EXISTS "notify"."alert_channels" (
  "alert_id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "channels" jsonb NOT NULL DEFAULT '["inapp"]'::jsonb,
  "webhook_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "notify"."alert_webhook_attempts" (
  "id" uuid PRIMARY KEY,
  "alert_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "seq" integer NOT NULL,
  "attempt" integer NOT NULL,
  "url" text NOT NULL,
  "body" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "http_status" integer,
  "error" text,
  "due_at" timestamptz NOT NULL,
  "claimed_until" timestamptz,
  "attempted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "alert_webhook_attempts_status_ck" CHECK ("status" IN ('pending', 'delivered', 'failed')),
  CONSTRAINT "alert_webhook_attempts_one_ux" UNIQUE ("alert_id", "seq", "attempt")
);
CREATE INDEX IF NOT EXISTS "alert_webhook_attempts_due_idx" ON "notify"."alert_webhook_attempts" ("due_at") WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "alert_webhook_attempts_user_idx" ON "notify"."alert_webhook_attempts" ("user_id", "created_at" DESC);
