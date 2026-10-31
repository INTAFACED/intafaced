ALTER TABLE "token"."launch_events" DROP CONSTRAINT IF EXISTS "launch_events_vesting_ck";
ALTER TABLE "token"."launch_events" DROP COLUMN IF EXISTS "vesting_end_at";
ALTER TABLE "token"."launch_events" DROP COLUMN IF EXISTS "vesting_cliff_at";
ALTER TABLE "token"."launch_events" DROP COLUMN IF EXISTS "vesting_start_at";
