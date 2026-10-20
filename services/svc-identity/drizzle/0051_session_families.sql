-- Sessions as sign-in families (ENGINE SES-1). One family is one sign-in on one device: the refresh
-- token rotates into a new row, and every row of that chain shares the family. Existing rows are each
-- their own family, which is true because only the newest row of a chain is live. user_agent and
-- country are what the device list shows; country stays empty until a trusted geo source feeds it.
-- Reversal: 0051_session_families.down.sql

ALTER TABLE "identity"."sessions" ADD COLUMN IF NOT EXISTS "family_id" uuid;
ALTER TABLE "identity"."sessions" ADD COLUMN IF NOT EXISTS "user_agent" text;
ALTER TABLE "identity"."sessions" ADD COLUMN IF NOT EXISTS "country" text;
UPDATE "identity"."sessions" SET "family_id" = "id" WHERE "family_id" IS NULL;
ALTER TABLE "identity"."sessions" ALTER COLUMN "family_id" SET DEFAULT gen_random_uuid();
ALTER TABLE "identity"."sessions" ALTER COLUMN "family_id" SET NOT NULL;
-- No new index: every family query also filters by user_id, which sessions_user_idx already serves.
