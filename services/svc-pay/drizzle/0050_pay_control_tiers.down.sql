-- intafaced:destructive — reversal of 0050_pay_control_tiers.sql
--
-- Drops tier definitions, merchant tier assignments and the control audit trail.
-- Exists so the migration is provably reversible in CI against a scratch schema.

DROP TRIGGER IF EXISTS "control_audit_append_only_trg" ON "pay"."control_audit";
DROP TABLE IF EXISTS "pay"."control_audit";
DROP TABLE IF EXISTS "pay"."control_merchant_profiles";
DROP TABLE IF EXISTS "pay"."control_tiers";
DROP FUNCTION IF EXISTS "pay"."control_append_only"();
