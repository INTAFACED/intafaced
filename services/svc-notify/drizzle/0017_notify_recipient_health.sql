-- svc-notify · recipient health and quarantine
-- Reversal: 0017_notify_recipient_health.down.sql
--
-- One row per (user, out-of-app channel) that has ever had a terminal send
-- failure. `address` pins the row to the address that failed: a changed address
-- starts clean. A quarantined recipient gets nothing non-critical until an
-- operator releases it; every release appends to the audit table below.

CREATE TABLE IF NOT EXISTS "notify"."recipient_health" (
  "user_id"              text NOT NULL,
  "channel"              text NOT NULL,
  "address"              text NOT NULL,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_failure_at"      timestamptz,
  "last_failure_code"    text,
  "quarantined_at"       timestamptz,
  "quarantine_reason"    text,
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "channel"),
  CONSTRAINT "recipient_health_channel_ck" CHECK ("channel" IN ('email', 'push', 'sms')),
  CONSTRAINT "recipient_health_quarantine_ck" CHECK (("quarantined_at" IS NULL) = ("quarantine_reason" IS NULL))
);

CREATE INDEX IF NOT EXISTS "recipient_health_quarantined_idx"
  ON "notify"."recipient_health" ("quarantined_at" DESC)
  WHERE "quarantined_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "notify"."recipient_release_audit" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            text NOT NULL,
  "channel"            text NOT NULL,
  "actor_id"           text NOT NULL,
  "reason"             text NOT NULL,
  "reason_id"          text NOT NULL,
  "quarantine_reason"  text NOT NULL,
  "released_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "recipient_release_audit_key_uq" UNIQUE ("user_id", "channel", "reason_id")
);

CREATE OR REPLACE FUNCTION notify.recipient_release_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notify.recipient_release_audit_immutable' USING ERRCODE = '23514';
END $$;

DROP TRIGGER IF EXISTS recipient_release_audit_immutable ON notify.recipient_release_audit;
CREATE TRIGGER recipient_release_audit_immutable
  BEFORE UPDATE OR DELETE ON notify.recipient_release_audit
  FOR EACH ROW EXECUTE FUNCTION notify.recipient_release_audit_immutable();
