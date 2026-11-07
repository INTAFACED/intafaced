-- svc-identity · a new-device sign-in waits on Home's "Needs you" until the person answers it (HM-dashboard-03,
-- I-signin-sessions-08; J-home-ia-11 #3, J-identity-06 #7). The `new_device` security event now names the trusted device
-- it is about and when the person said "this was me". The work item is derived, never stored: it exists while the event
-- is unreviewed and its device is still trusted, so removing the device or confirming it ends it.
-- Reversal: the matching .down.sql
ALTER TABLE "identity"."security_factor_events"
  ADD COLUMN IF NOT EXISTS "trusted_device_id" uuid REFERENCES "identity"."trusted_devices"(id) ON DELETE SET NULL;
ALTER TABLE "identity"."security_factor_events" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz;
-- Events written before this change name no device, so nothing could ever end their item: they count as answered.
UPDATE "identity"."security_factor_events" SET "reviewed_at" = now() WHERE "change" = 'new_device' AND "reviewed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "security_factor_events_unreviewed_idx"
  ON "identity"."security_factor_events" ("user_id") WHERE "change" = 'new_device' AND "reviewed_at" IS NULL;
