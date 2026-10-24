-- Drops the saved sign-in and device. Code from before this writes only `link`, so the check goes back to `link` alone
-- for new rows; entries already approved from a device keep that record (NOT VALID leaves existing rows as they are).
ALTER TABLE "bank"."user_withdraw_destinations"
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_approved_by_ck",
  ADD CONSTRAINT "user_withdraw_destinations_approved_by_ck" CHECK ("approved_by" IS NULL OR "approved_by" IN ('link')) NOT VALID,
  DROP COLUMN IF EXISTS "saved_dev",
  DROP COLUMN IF EXISTS "saved_fam";
