-- intafaced:destructive drops which customer records were archived and why; those accounts read as closed again, and a
-- customer-closed one becomes reopenable. founder_control_audit is append-only, so its 'archive' rows stay as history;
-- the narrower kind check is added NOT VALID, so it binds new rows only.
ALTER TABLE "identity"."founder_control_audit" DROP CONSTRAINT IF EXISTS "founder_control_audit_kind_check";
ALTER TABLE "identity"."founder_control_audit"
  ADD CONSTRAINT "founder_control_audit_kind_check" CHECK ("kind" IN ('identity', 'entitlement', 'bootstrap', 'closure', 'tier')) NOT VALID;
ALTER TABLE "identity"."users" DROP CONSTRAINT IF EXISTS "users_archive_ck";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "archive_reason";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "archived_at";
