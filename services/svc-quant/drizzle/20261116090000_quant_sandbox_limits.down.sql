-- Reverses the sandbox limits migration (J-algo-dev-12). Every sandbox limit and its audit rows are lost; every run then
-- refuses quant.sandbox_limit_unset until the limits are set again.
DROP TABLE IF EXISTS "quant"."sandbox_limits";
DELETE FROM "quant"."quota_audit" WHERE "action" = 'sandbox';
ALTER TABLE "quant"."quota_audit" DROP CONSTRAINT IF EXISTS "quota_audit_action_check";
ALTER TABLE "quant"."quota_audit" ADD CONSTRAINT "quota_audit_action_check" CHECK ("action" IN ('set', 'assign', 'tier'));
