-- Reverses 20261025030000_vip_reviews.sql.
DROP TRIGGER IF EXISTS "vip_trials_append_only_trg" ON "trade"."vip_trials";
DROP TABLE IF EXISTS "trade"."vip_trials";
DROP FUNCTION IF EXISTS "trade"."vip_trials_append_only"();
DROP TRIGGER IF EXISTS "vip_applications_status_forward_trg" ON "trade"."vip_applications";
DROP FUNCTION IF EXISTS "trade"."vip_applications_status_forward"();
DROP INDEX IF EXISTS "trade"."vip_application_events_approval_idx";
ALTER TABLE "trade"."vip_application_events" DROP CONSTRAINT IF EXISTS "vip_application_events_four_eyes_ck";
ALTER TABLE "trade"."vip_application_events" DROP COLUMN IF EXISTS "approval_id";
ALTER TABLE "trade"."vip_application_events" DROP COLUMN IF EXISTS "approver_id";
