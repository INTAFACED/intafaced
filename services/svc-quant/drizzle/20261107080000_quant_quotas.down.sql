-- Reverses the quotas migration (AL-limits-01). Every profile, assignment and audit row is lost; no strategy or run is touched.
DROP INDEX IF EXISTS "quant"."runs_user_finished_idx";
DROP TABLE IF EXISTS "quant"."quota_audit";
DROP TABLE IF EXISTS "quant"."quota_assignments";
DROP TABLE IF EXISTS "quant"."quota_limits";
