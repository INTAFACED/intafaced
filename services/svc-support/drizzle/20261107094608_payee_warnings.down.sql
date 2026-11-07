-- Reverse 20261107094608_payee_warnings.sql
-- intafaced:destructive drops the record of which payee warnings each person has read; each warning then shows once more.

DROP TRIGGER IF EXISTS "payee_warnings_seen_append_only_trg" ON "support"."payee_warnings_seen";
DROP TABLE IF EXISTS "support"."payee_warnings_seen";
