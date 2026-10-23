-- Reverses 0069_staff_account_closure.sql. Staff close reason codes and the frozen-at-close flag are dropped. founder_control_audit is append-only,
-- so its 'closure' rows stay as history; the narrower kind check is added NOT VALID, so it binds new rows only.
ALTER TABLE "identity"."founder_control_audit" DROP CONSTRAINT IF EXISTS "founder_control_audit_kind_check";
ALTER TABLE "identity"."founder_control_audit"
  ADD CONSTRAINT "founder_control_audit_kind_check" CHECK ("kind" IN ('identity', 'entitlement', 'bootstrap')) NOT VALID;
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "closed_from_frozen";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "closed_reason";
