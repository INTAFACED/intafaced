-- svc-notify · C-alerts-scan-01c alert trigger frequency
-- Reversal: 0022_notify_alert_frequency.down.sql
--
-- An alert is one-shot ('once') unless the person chose 'every_crossing' and the owner allows it. A repeating alert stays
-- active after it fires, counts its fires and remembers when the last one was.
--
-- The trigger log keeps one row per fire, so its key is (alert_id, seq): seq 1 for a one-shot alert, the fire count plus one for
-- a repeating one. alert_triggers is keyed by alert_id alone, so the log moves to alert_fires with the new key and every
-- existing row is copied as seq 1. alert_triggers is no longer read or written; a later reviewed migration drops it.

ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "frequency" text NOT NULL DEFAULT 'once';
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "fire_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "last_fired_at" timestamptz;

CREATE TABLE IF NOT EXISTS "notify"."alert_fires" (
  "alert_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "user_id" text NOT NULL,
  "market_id" text NOT NULL,
  "condition" text NOT NULL,
  "target_price" text NOT NULL,
  "mark_price" text NOT NULL,
  "fired_at" timestamptz NOT NULL,
  "notification_id" text,
  PRIMARY KEY ("alert_id", "seq")
);
CREATE INDEX IF NOT EXISTS "alert_fires_user_fired_idx" ON "notify"."alert_fires" ("user_id", "fired_at" DESC);
CREATE INDEX IF NOT EXISTS "alert_fires_fired_idx" ON "notify"."alert_fires" ("fired_at");

INSERT INTO "notify"."alert_fires" ("alert_id", "seq", "user_id", "market_id", "condition", "target_price", "mark_price", "fired_at", "notification_id")
SELECT "alert_id", 1, "user_id", "market_id", "condition", "target_price", "mark_price", "fired_at", "notification_id"
FROM "notify"."alert_triggers"
ON CONFLICT DO NOTHING;
