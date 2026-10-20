-- svc-notify · channel settings and identity message templates (I-order-01)
-- Reversal: 0014_notify_channel_templates.down.sql
--
-- Both are append-only history behind a two-person approval. channel_settings
-- holds the latest row per channel for the dispatch read; the history table keeps
-- every change. message_templates is versioned: a change is a new row, and an
-- in-flight send keeps the version it started with. No copy is seeded.

CREATE TABLE IF NOT EXISTS "notify"."channel_settings" (
  "channel"      text PRIMARY KEY,
  "enabled"      boolean NOT NULL,
  "adapter"      text,
  "version"      integer NOT NULL,
  "updated_by"   text NOT NULL,
  "approval_id"  text NOT NULL,
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "channel_settings_channel_ck" CHECK ("channel" IN ('email', 'push', 'sms')),
  CONSTRAINT "channel_settings_version_ck" CHECK ("version" >= 1)
);

CREATE TABLE IF NOT EXISTS "notify"."channel_settings_history" (
  "channel"      text NOT NULL,
  "version"      integer NOT NULL,
  "enabled"      boolean NOT NULL,
  "adapter"      text,
  "changed_by"   text NOT NULL,
  "approval_id"  text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("channel", "version"),
  CONSTRAINT "channel_settings_history_channel_ck" CHECK ("channel" IN ('email', 'push', 'sms'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "channel_settings_history_approval_uq"
  ON "notify"."channel_settings_history" ("approval_id");

CREATE TABLE IF NOT EXISTS "notify"."message_templates" (
  "template_key"  text NOT NULL,
  "version"       integer NOT NULL,
  "subject"       text NOT NULL,
  "body"          text NOT NULL,
  "author_id"     text NOT NULL,
  "approval_id"   text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("template_key", "version"),
  CONSTRAINT "message_templates_key_ck" CHECK ("template_key" IN (
    'recovery_code', 'verification_code', 'login_code', 'registration_code', 'security_notice', 'kyc_decision'
  )),
  CONSTRAINT "message_templates_copy_ck" CHECK (btrim("subject") <> '' AND btrim("body") <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_templates_approval_uq"
  ON "notify"."message_templates" ("approval_id");

CREATE OR REPLACE FUNCTION notify.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notify.append_only' USING ERRCODE = '23514';
END $$;

DROP TRIGGER IF EXISTS channel_settings_history_append_only ON notify.channel_settings_history;
CREATE TRIGGER channel_settings_history_append_only
  BEFORE UPDATE OR DELETE ON notify.channel_settings_history
  FOR EACH ROW EXECUTE FUNCTION notify.append_only();

DROP TRIGGER IF EXISTS message_templates_append_only ON notify.message_templates;
CREATE TRIGGER message_templates_append_only
  BEFORE UPDATE OR DELETE ON notify.message_templates
  FOR EACH ROW EXECUTE FUNCTION notify.append_only();
