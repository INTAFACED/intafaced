-- Reverse 20261123030000_read_grants.sql
-- intafaced:destructive the grants customers gave support and the list of reads under them are dropped; no figure was ever stored in them.

DROP TRIGGER IF EXISTS "read_grant_reads_append_only_trg" ON "support"."read_grant_reads";
DROP TRIGGER IF EXISTS "read_grants_append_only_trg" ON "support"."read_grants";
DROP TABLE IF EXISTS "support"."read_grant_reads";
DROP TABLE IF EXISTS "support"."read_grants";
DROP FUNCTION IF EXISTS "support"."read_grants_append_only"();
