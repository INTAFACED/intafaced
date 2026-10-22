-- intafaced:destructive drops the schedule edit records and the revision/reference columns. Cancel or finish every
-- `once` schedule first: old code does not know the cadence. The 'once' enum value stays (Postgres cannot drop it).
DROP TABLE IF EXISTS "bank"."schedule_edits";
ALTER TABLE "bank"."scheduled_transfers" DROP COLUMN IF EXISTS "reference";
ALTER TABLE "bank"."scheduled_transfers" DROP COLUMN IF EXISTS "revision";
