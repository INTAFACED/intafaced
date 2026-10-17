-- W15 merchant operations: in-app notification feed and preferences.
--
-- IN-APP RECORDS ONLY. Nothing here sends email or SMS. A row is something a
-- merchant sees when they open the portal.
--
-- `dedupe_key` lets a producer say "I already told them about this" so a retried
-- job or a replayed event adds one row, not two.

CREATE TABLE IF NOT EXISTS "pay"."merchant_notifications" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "kind"         text NOT NULL CONSTRAINT "merchant_notifications_kind_ck" CHECK ("kind" IN (
                   'payout_awaiting_approval', 'settlement_failed', 'payout_failed', 'limit_threshold',
                   'dispute_opened', 'dispute_due', 'webhook_failing', 'operator_pause', 'export_ready', 'team_change')),
  "title"        text NOT NULL CONSTRAINT "merchant_notifications_title_not_blank" CHECK (length(btrim("title")) > 0),
  "body"         text,
  "subject_type" text,
  "subject_id"   text,
  "dedupe_key"   text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "read_at"      timestamptz,
  "read_by"      text
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_notifications_dedupe_idx"
  ON "pay"."merchant_notifications" ("merchant_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "merchant_notifications_feed_idx"
  ON "pay"."merchant_notifications" ("merchant_id", "created_at" DESC, "id" DESC);

-- One row per (merchant, kind). No row means "in-app on"; there is no default threshold.
CREATE TABLE IF NOT EXISTS "pay"."merchant_notification_preferences" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "kind"        text NOT NULL,
  "in_app"      boolean NOT NULL DEFAULT true,
  -- Merchant-chosen decimal string (for limit_threshold); NULL = merchant has not chosen one.
  "threshold"   text CONSTRAINT "merchant_notification_preferences_threshold_ck" CHECK ("threshold" IS NULL OR "threshold" ~ '^[0-9]+(\.[0-9]{1,18})?$'),
  "updated_by"  text NOT NULL CONSTRAINT "merchant_notification_preferences_by_not_blank" CHECK (length(btrim("updated_by")) > 0),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "kind")
);
