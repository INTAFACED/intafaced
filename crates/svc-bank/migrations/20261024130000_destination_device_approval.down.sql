-- Drops the saved sign-in and device. The `approved_by` check keeps `device`: entries approved from a device keep that
-- record and stay updatable (a rename rewrites the row), and code from before this only ever writes `link`.
ALTER TABLE "bank"."user_withdraw_destinations"
  DROP COLUMN IF EXISTS "saved_dev",
  DROP COLUMN IF EXISTS "saved_fam";
