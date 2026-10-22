-- Sub-account label and purpose edits (RC-identity-14, TRD-0707). One row per change, written in the same
-- transaction as the change, with the old and new text. The sub-account id is never changed. No balance, no ledger.
-- Reversal: 0065_sub_account_label_audit.down.sql

CREATE TABLE IF NOT EXISTS "identity"."sub_account_label_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sub_account_id" uuid NOT NULL REFERENCES "identity"."sub_accounts" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "session_id" text NOT NULL,
  "old_label" text NOT NULL,
  "new_label" text NOT NULL,
  "old_purpose" text,
  "new_purpose" text,
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "sub_account_label_audit_sub_idx" ON "identity"."sub_account_label_audit" ("sub_account_id", "at" DESC);
