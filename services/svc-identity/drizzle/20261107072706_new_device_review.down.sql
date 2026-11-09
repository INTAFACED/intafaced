-- Reverses the new-device review: Home's "Needs you" stops listing new-device sign-ins. The events themselves stay.
DROP INDEX IF EXISTS "identity"."security_factor_events_unreviewed_device_idx";
DROP INDEX IF EXISTS "identity"."security_factor_events_unreviewed_idx";
ALTER TABLE "identity"."security_factor_events" DROP COLUMN IF EXISTS "reviewed_at";
ALTER TABLE "identity"."security_factor_events" DROP COLUMN IF EXISTS "trusted_device_id";
