-- Reverse 0015_staff_availability.sql
-- Lossy by nature: availability history and heartbeats are dropped.

DROP TABLE IF EXISTS "support"."staff_availability_log";
ALTER TABLE "support"."staff" DROP CONSTRAINT IF EXISTS "staff_availability_ck";
ALTER TABLE "support"."staff"
  DROP COLUMN IF EXISTS "last_heartbeat_at",
  DROP COLUMN IF EXISTS "availability_at",
  DROP COLUMN IF EXISTS "availability";
