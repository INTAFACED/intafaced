-- Reverses 20261107083559_staff_directory.sql. The identity accounts staff created at first connection stay; only the
-- staff directory, its invite tokens and audit, and the console-set policy rows go (the deployment's rows apply again).
DROP TABLE IF EXISTS "identity"."staff_change_audit";
DROP TABLE IF EXISTS "identity"."staff_invite_tokens";
DROP TABLE IF EXISTS "identity"."staff_members";
DROP TABLE IF EXISTS "identity"."approval_policy_row_changes";
DROP TABLE IF EXISTS "identity"."approval_policy_rows";
