-- Reverses 20261031054001_staff_roster.sql.
-- intafaced:destructive drops the staff roster, its custom roles, assignments, change audit and unpublished staff
-- events. Customer accounts are untouched; events already published stay with their consumers.
DROP TABLE IF EXISTS "identity"."staff_events";
DROP TRIGGER IF EXISTS "staff_change_audit_append_only" ON "identity"."staff_change_audit";
DROP TABLE IF EXISTS "identity"."staff_change_audit";
DROP FUNCTION IF EXISTS "identity"."staff_change_audit_append_only"();
DROP TABLE IF EXISTS "identity"."staff_role_assignments";
DROP TABLE IF EXISTS "identity"."staff_roles";
DROP TABLE IF EXISTS "identity"."staff_members";
