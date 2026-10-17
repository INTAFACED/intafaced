-- intafaced:destructive — drops consume provenance and the identity trading-restriction table.
-- Forward migration: 0038_action_approval_consume_provenance.sql

DROP TABLE IF EXISTS "identity"."trading_restrictions";
ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_consume_provenance_ck";
ALTER TABLE "identity"."action_approvals" DROP COLUMN IF EXISTS "consumed_request_id";
ALTER TABLE "identity"."action_approvals" DROP COLUMN IF EXISTS "consumed_by_principal";
ALTER TABLE "identity"."action_approvals" DROP COLUMN IF EXISTS "consumed_by_service";
