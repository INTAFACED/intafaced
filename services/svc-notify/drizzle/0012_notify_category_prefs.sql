-- svc-notify · notification choices by category and channel, with history
-- Reversal: 0012_notify_category_prefs.down.sql
--
-- A missing row means the category is on for that channel. `security` is
-- locked on in code and never written here. Every change is appended to the
-- history table, so two devices that write the same cell both stay on record.

CREATE TABLE IF NOT EXISTS "notify"."category_prefs" (
  "user_id"     text NOT NULL,
  "category"    text NOT NULL,
  "channel"     text NOT NULL,
  "enabled"     boolean NOT NULL,
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "category_prefs_pk" PRIMARY KEY ("user_id", "category", "channel"),
  CONSTRAINT "category_prefs_category_ck" CHECK ("category" IN ('orders', 'price_alerts', 'promotions', 'news', 'status')),
  CONSTRAINT "category_prefs_channel_ck" CHECK ("channel" IN ('email', 'push', 'sms'))
);

CREATE TABLE IF NOT EXISTS "notify"."category_pref_history" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     text NOT NULL,
  "category"    text NOT NULL,
  "channel"     text NOT NULL,
  "enabled"     boolean NOT NULL,
  "changed_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "category_pref_history_user_idx"
  ON "notify"."category_pref_history" ("user_id", "changed_at");
