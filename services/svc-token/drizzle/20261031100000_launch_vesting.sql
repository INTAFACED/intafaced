-- MC-launch-05: a launch's distribution schedule, an issuer input approved with the draft. Linear from start to end,
-- nothing vested before the cliff. All null is "schedule not set"; a start needs an end, and a cliff needs both.
ALTER TABLE "token"."launch_events" ADD COLUMN IF NOT EXISTS "vesting_start_at" timestamptz;
ALTER TABLE "token"."launch_events" ADD COLUMN IF NOT EXISTS "vesting_cliff_at" timestamptz;
ALTER TABLE "token"."launch_events" ADD COLUMN IF NOT EXISTS "vesting_end_at" timestamptz;
ALTER TABLE "token"."launch_events" DROP CONSTRAINT IF EXISTS "launch_events_vesting_ck";
ALTER TABLE "token"."launch_events" ADD CONSTRAINT "launch_events_vesting_ck" CHECK (
  ("vesting_start_at" IS NULL AND "vesting_end_at" IS NULL AND "vesting_cliff_at" IS NULL)
  OR (
    "vesting_start_at" IS NOT NULL AND "vesting_end_at" IS NOT NULL AND "vesting_start_at" < "vesting_end_at"
    AND ("vesting_cliff_at" IS NULL OR "vesting_cliff_at" BETWEEN "vesting_start_at" AND "vesting_end_at")
  )
);
