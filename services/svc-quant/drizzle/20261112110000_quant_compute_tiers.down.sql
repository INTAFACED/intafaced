-- Reverses the compute tiers migration (RC-algo-dev-05). Every tier and its audit rows are lost; no profile, limit,
-- assignment, strategy or run is touched.
DELETE FROM "quant"."quota_audit" WHERE "action" = 'tier';
ALTER TABLE "quant"."quota_audit" DROP CONSTRAINT IF EXISTS "quota_audit_action_check";
ALTER TABLE "quant"."quota_audit" ADD CONSTRAINT "quota_audit_action_check" CHECK ("action" IN ('set', 'assign'));
DROP TABLE IF EXISTS "quant"."compute_tiers";
