-- Reverses 20261107100000_launch_issuance_kind.sql.
ALTER TABLE "token"."launch_events" DROP CONSTRAINT IF EXISTS "launch_events_issuance_flags_ck";
ALTER TABLE "token"."launch_events" DROP CONSTRAINT IF EXISTS "launch_events_issuance_ck";
ALTER TABLE "token"."launch_events" DROP COLUMN IF EXISTS "issuance_flags";
ALTER TABLE "token"."launch_events" DROP COLUMN IF EXISTS "leg_terms";
ALTER TABLE "token"."launch_events" DROP COLUMN IF EXISTS "oracle";
ALTER TABLE "token"."launch_events" DROP COLUMN IF EXISTS "backing_asset";
ALTER TABLE "token"."launch_events" DROP COLUMN IF EXISTS "issuance_kind";
