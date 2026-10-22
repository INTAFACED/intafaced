-- Reverses 0070_organization_role_changed_history.sql. Role-change history rows are dropped; memberships stay.
DELETE FROM "identity"."organization_history" WHERE "kind" = 'role_changed';
ALTER TABLE "identity"."organization_history" DROP CONSTRAINT IF EXISTS "organization_history_kind_check";
ALTER TABLE "identity"."organization_history"
  ADD CONSTRAINT "organization_history_kind_check" CHECK ("kind" IN ('member_removed', 'renamed'));
