-- Reverses 0070_account_tiers.sql. Tier assignments are dropped (accounts read as never put on a tier). founder_control_audit
-- is append-only, so its 'tier' rows stay as history; the narrower kind check is added NOT VALID, so it binds new rows only.
ALTER TABLE "identity"."founder_control_audit" DROP CONSTRAINT IF EXISTS "founder_control_audit_kind_check";
ALTER TABLE "identity"."founder_control_audit"
  ADD CONSTRAINT "founder_control_audit_kind_check" CHECK ("kind" IN ('identity', 'entitlement', 'bootstrap', 'closure')) NOT VALID;
DROP TABLE IF EXISTS "identity"."account_tier_assignments";
