-- Reverses 20261031045011_quant_quotas.sql. Drops every quota profile and assignment: an operator sets them again after.
DROP TRIGGER IF EXISTS "quota_assignments_append_only" ON "quant"."quota_assignments";
DROP TRIGGER IF EXISTS "quota_limits_append_only" ON "quant"."quota_limits";
DROP FUNCTION IF EXISTS "quant"."reject_quota_rewrite"();
ALTER TABLE "quant"."runs" DROP COLUMN IF EXISTS "log_lines";
ALTER TABLE "quant"."runs" DROP COLUMN IF EXISTS "result_bytes";
DROP INDEX IF EXISTS "quant"."runs_in_flight_idx";
DROP TABLE IF EXISTS "quant"."quota_assignments";
DROP TABLE IF EXISTS "quant"."quota_limits";
