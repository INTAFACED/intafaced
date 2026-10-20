DROP TRIGGER IF EXISTS recipient_release_audit_immutable ON notify.recipient_release_audit;
DROP FUNCTION IF EXISTS notify.recipient_release_audit_immutable();
DROP TABLE IF EXISTS "notify"."recipient_release_audit";
DROP TABLE IF EXISTS "notify"."recipient_health";
