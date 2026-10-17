-- intafaced:destructive — deletes every same_person action approval and drops action_approvals.kind and session_id.
-- Those rows are short-lived money-out step-up approvals (five minutes) that a service has consumed or that expired;
-- the restored distinct-people CHECK would reject them, so they are removed first. Forward migration: 0029_action_approval_same_person.sql

DELETE FROM "identity"."action_approvals" WHERE "kind" = 'same_person';

ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_same_person_ck";
ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_distinct_ck";
ALTER TABLE "identity"."action_approvals"
  ADD CONSTRAINT "action_approvals_distinct_ck" CHECK ("approver_id" IS NULL OR "approver_id" <> "requester_id");
ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_kind_ck";
ALTER TABLE "identity"."action_approvals" DROP COLUMN IF EXISTS "session_id";
ALTER TABLE "identity"."action_approvals" DROP COLUMN IF EXISTS "kind";
