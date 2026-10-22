-- Reverse 0017. Drops the export/receipt audit and quota counter.
DROP INDEX IF EXISTS "p2p"."export_audit_user_kind_idx";
DROP TABLE IF EXISTS "p2p"."export_audit";
