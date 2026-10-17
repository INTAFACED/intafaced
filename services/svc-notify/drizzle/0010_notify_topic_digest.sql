-- svc-notify · per-topic choices, digest mode, quiet hours, and held summaries
-- Reversal: 0010_notify_topic_digest.down.sql
--
-- A missing row means the historical behaviour: the topic is enabled on that
-- channel, delivery is immediate, and there is no quiet window. Critical
-- severity still ignores every one of these rows in dispatch.

CREATE TABLE IF NOT EXISTS "notify"."topic_prefs" (
  "user_id"     text NOT NULL,
  "topic"       text NOT NULL,
  "channel"     text NOT NULL,
  "enabled"     boolean NOT NULL,
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "topic_prefs_pk" PRIMARY KEY ("user_id", "topic", "channel"),
  CONSTRAINT "topic_prefs_topic_ck" CHECK ("topic" IN ('trade', 'p2p', 'identity', 'bank', 'token', 'agents')),
  CONSTRAINT "topic_prefs_channel_ck" CHECK ("channel" IN ('email', 'push', 'sms'))
);

CREATE TABLE IF NOT EXISTS "notify"."digest_prefs" (
  "user_id"      text PRIMARY KEY,
  "mode"         text NOT NULL,
  "quiet_start"  text,
  "quiet_end"    text,
  "quiet_zone"   text,
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "digest_prefs_mode_ck" CHECK ("mode" IN ('immediate', 'hourly', 'daily')),
  CONSTRAINT "digest_prefs_quiet_ck" CHECK (
    ("quiet_start" IS NULL AND "quiet_end" IS NULL AND "quiet_zone" IS NULL)
    OR ("quiet_start" IS NOT NULL AND "quiet_end" IS NOT NULL AND "quiet_zone" IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS "notify"."preference_commands" (
  "user_id"            text NOT NULL,
  "procedure"          text NOT NULL,
  "client_request_id"  text NOT NULL,
  "result"             jsonb NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "preference_commands_pk" PRIMARY KEY ("user_id", "procedure", "client_request_id")
);

CREATE TABLE IF NOT EXISTS "notify"."digest_summaries" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      text NOT NULL,
  "released_at"  timestamptz NOT NULL,
  "notice_ids"   jsonb NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "notify"."digest_holds" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          text NOT NULL,
  "notification_id"  uuid NOT NULL REFERENCES "notify"."notifications" ("id") ON DELETE CASCADE,
  "channel"          text NOT NULL,
  "hold_until"       timestamptz NOT NULL,
  "summary_id"       uuid REFERENCES "notify"."digest_summaries" ("id"),
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "digest_holds_channel_ck" CHECK ("channel" IN ('email', 'push', 'sms')),
  CONSTRAINT "digest_holds_once" UNIQUE ("notification_id", "channel")
);

CREATE INDEX IF NOT EXISTS "digest_holds_due_idx"
  ON "notify"."digest_holds" ("user_id", "hold_until")
  WHERE "summary_id" IS NULL;
