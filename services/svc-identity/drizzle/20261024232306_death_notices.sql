-- svc-identity · death notices (RC-identity-02, J-identity-05 #7). Staff record a notice that an account holder has
-- died; recording changes nothing on the account, because a false report must never lock a living person. A second
-- person approves the confirmation (a four-eyes `identity.death_notice_confirm` approval); confirming freezes the
-- account and revokes its sessions, API keys and sub-accounts in the same transaction. Each notice is published twice
-- from this row (created, then confirmed), at least once, by a relay that marks the row after the publish. A notice is
-- unique per account and case reference, so recording it again is one row. Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."death_notices" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_user_id"        uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "case_ref"               text NOT NULL CHECK (char_length("case_ref") BETWEEN 1 AND 64),
  "status"                 text NOT NULL DEFAULT 'received'
                             CHECK ("status" IN ('received', 'confirmed', 'rejected')),
  "reporter_kind"          text NOT NULL CHECK ("reporter_kind" IN ('executor', 'administrator', 'family', 'other')),
  "evidence_document_ids"  uuid[] NOT NULL DEFAULT '{}',
  "recorded_by"            uuid NOT NULL,
  "received_at"            timestamptz NOT NULL,
  "decided_at"             timestamptz,
  "decided_by"             uuid,
  "approval_id"            text,
  "approved_by"            uuid,
  -- The account's identity_control_version right after the confirming freeze. Any later change of the account (a
  -- restore, another freeze, a closure) moves the version on, and the recovery claim check then refuses.
  "frozen_control_version" bigint,
  "created_published_at"   timestamptz,
  "confirmed_published_at" timestamptz,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "death_notices_case_key" UNIQUE ("subject_user_id", "case_ref"),
  CONSTRAINT "death_notices_recorder_not_subject" CHECK ("recorded_by" <> "subject_user_id"),
  CONSTRAINT "death_notices_four_eyes" CHECK (
    "status" <> 'confirmed' OR ("approved_by" IS NOT NULL AND "approved_by" <> "decided_by" AND "frozen_control_version" IS NOT NULL)
  )
);
-- One confirmed notice per account.
CREATE UNIQUE INDEX IF NOT EXISTS "death_notices_one_confirmed_uq"
  ON "identity"."death_notices" ("subject_user_id") WHERE "status" = 'confirmed';
CREATE INDEX IF NOT EXISTS "death_notices_unpublished_idx"
  ON "identity"."death_notices" ("created_at")
  WHERE "created_published_at" IS NULL OR ("status" = 'confirmed' AND "confirmed_published_at" IS NULL);
