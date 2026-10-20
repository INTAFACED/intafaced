-- svc-notify · audience-all system notices with per-user read marks
-- Reversal: 0016_notify_system_notices.down.sql
--
-- One row per platform-wide event (a posting freeze set or cleared). Every
-- user's inbox read merges these rows in; a user's read mark lives in
-- system_notice_reads, so a freeze is one write, not one write per account.

CREATE TABLE IF NOT EXISTS "notify"."system_notices" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"                    text NOT NULL,
  "title_key"               text NOT NULL,
  "body_key"                text NOT NULL,
  "params"                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  "href"                    text,
  "severity"                text NOT NULL DEFAULT 'info',
  "source_subject"          text NOT NULL,
  "source_idempotency_key"  text NOT NULL,
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "system_notices_severity_ck" CHECK ("severity" IN ('info', 'action', 'critical')),
  CONSTRAINT "system_notices_source_uq" UNIQUE ("source_subject", "source_idempotency_key")
);

CREATE TABLE IF NOT EXISTS "notify"."system_notice_reads" (
  "notice_id"  uuid NOT NULL REFERENCES "notify"."system_notices" ("id") ON DELETE CASCADE,
  "user_id"    text NOT NULL,
  "read_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("notice_id", "user_id")
);
