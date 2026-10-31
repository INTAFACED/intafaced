-- intafaced:destructive — drops the per-type approval votes and the policy columns of action approvals.
-- Forward migration: 20261030023842_action_approval_policy_votes.sql

DROP TABLE IF EXISTS "identity"."action_approval_votes";
ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_policy_ck";
ALTER TABLE "identity"."action_approvals" DROP COLUMN IF EXISTS "policy_hash";
ALTER TABLE "identity"."action_approvals" DROP COLUMN IF EXISTS "approvals_given";
ALTER TABLE "identity"."action_approvals" DROP COLUMN IF EXISTS "approvals_required";
