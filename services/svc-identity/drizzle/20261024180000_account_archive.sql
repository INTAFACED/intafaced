-- svc-identity · archive of one customer record (J-ops-console-04 #10, OPS-accounts-desk-02). `archived_at` and
-- `archive_reason` are set once, together, by a four-eyes staff archive of a closed account, and never cleared: the record
-- is read-only afterwards and returning takes a new application. The archive history is kept in founder_control_audit
-- under its own kind.
-- Reversal: the .down.sql of the same name.
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "archive_reason" text;
ALTER TABLE "identity"."users" DROP CONSTRAINT IF EXISTS "users_archive_ck";
ALTER TABLE "identity"."users"
  ADD CONSTRAINT "users_archive_ck" CHECK (
    ("archived_at" IS NULL) = ("archive_reason" IS NULL)
    AND ("archive_reason" IS NULL OR "archive_reason" IN ('dormant', 'customer_request', 'duplicate', 'other'))
    AND ("archived_at" IS NULL OR "status" = 'closed')
  );

ALTER TABLE "identity"."founder_control_audit" DROP CONSTRAINT IF EXISTS "founder_control_audit_kind_check";
ALTER TABLE "identity"."founder_control_audit"
  ADD CONSTRAINT "founder_control_audit_kind_check" CHECK ("kind" IN ('identity', 'entitlement', 'bootstrap', 'closure', 'tier', 'archive'));
