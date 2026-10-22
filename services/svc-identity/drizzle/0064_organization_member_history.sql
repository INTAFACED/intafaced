-- Organisation membership and name history (I-account-lifecycle-05). One row per change, written in the same
-- transaction as the change. No balance, no ledger.
-- Reversal: 0064_organization_member_history.down.sql

CREATE TABLE IF NOT EXISTS "identity"."organization_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "identity"."organizations" ("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('member_removed', 'renamed')),
  "subject_id" uuid,
  "before" text,
  "after" text,
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "organization_history_org_idx" ON "identity"."organization_history" ("org_id", "at" DESC);
