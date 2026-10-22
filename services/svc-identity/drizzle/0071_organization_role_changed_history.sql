-- Organisation role changes join the history (review #5825 follow-up). grantOrgRole writes one 'role_changed' row
-- (subject, before role, after role) in the same transaction as the change. No balance, no ledger.
-- Reversal: 0071_organization_role_changed_history.down.sql

ALTER TABLE "identity"."organization_history" DROP CONSTRAINT IF EXISTS "organization_history_kind_check";
ALTER TABLE "identity"."organization_history"
  ADD CONSTRAINT "organization_history_kind_check" CHECK ("kind" IN ('member_removed', 'renamed', 'role_changed'));
