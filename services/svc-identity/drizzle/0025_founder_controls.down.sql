-- intafaced:destructive — reviewed reversal removes control configuration/history.
DROP TABLE IF EXISTS "identity"."founder_control_requests";
DROP TABLE IF EXISTS "identity"."founder_control_audit";
DROP TABLE IF EXISTS "identity"."founder_operator_entitlements";
DROP TABLE IF EXISTS "identity"."founder_control_configuration";
DROP FUNCTION IF EXISTS "identity"."founder_control_history_immutable"();
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "identity_control_version";
